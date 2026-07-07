import type { AuthProvider } from '../auth/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import type {
  CommitRequest,
  ForgeActor,
  ForgeAdapter,
  ForgeContext,
  ForgeEvent,
  ForgeKind,
  ForgePullRequest,
  ForgeRepo,
  OpenPrRequest,
  PullRequestRef,
  ReviewSubmission,
  TrackingComment,
} from './types.ts';

export interface ForgejoForgeOptions {
  auth: AuthProvider;
  repo: ForgeRepo;
  /** Forgejo API root, e.g. `https://forgejo.example.com/api/v1`. */
  baseUrl: string;
}

function permissionToAssociation(permission: string): string {
  switch (permission) {
    // Forgejo/Gitea emits `owner` for org owners (GitHub never does — it uses `admin`).
    // Both are the highest access tier, so both map to OWNER.
    case 'owner':
    case 'admin':
      return 'OWNER';
    case 'write':
      return 'COLLABORATOR';
    default:
      return 'NONE';
  }
}

/**
 * Forgejo/Gitea adapter. Forgejo has no GitHub App equivalent, so auth is always a
 * scoped token. The REST surface is GitHub-shaped but distinct, so this talks to
 * `/api/v1` directly via fetch rather than reusing Octokit.
 */
export class ForgejoForge implements ForgeAdapter {
  readonly kind: ForgeKind = 'forgejo';
  readonly repo: ForgeRepo;
  private readonly auth: AuthProvider;
  private readonly baseUrl: string;

  constructor(options: ForgejoForgeOptions) {
    this.auth = options.auth;
    this.repo = options.repo;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
  }

  private get prefix(): string {
    return `/repos/${this.repo.owner}/${this.repo.name}`;
  }

  private async headers(): Promise<Record<string, string>> {
    const token = await this.auth.getToken();
    return { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  }

  private async api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | undefined }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: await this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : undefined;
    if (!res.ok && res.status !== 404) {
      throw new Error(`crabd forgejo: ${method} ${path} → ${res.status} ${text.slice(0, 300)}`);
    }
    return { status: res.status, data };
  }

  private async raw(path: string): Promise<string> {
    const token = await this.auth.getToken();
    const res = await fetch(`${this.baseUrl}${path}`, { headers: { Authorization: `token ${token}` } });
    return res.ok ? res.text() : '';
  }

  async getContext(event: ForgeEvent): Promise<ForgeContext> {
    const context: ForgeContext = {
      repo: this.repo,
      issue: event.issue,
      pullRequest: event.pullRequest,
      comments: [],
      changedFiles: [],
    };

    const subject = event.pullRequest?.number ?? event.issue?.number;
    if (subject !== undefined) {
      const { data: comments } = await this.api<
        { id: number; body?: string; user?: { login?: string }; created_at?: string }[]
      >('GET', `${this.prefix}/issues/${subject}/comments`);
      context.comments = (comments ?? []).map((c) => ({
        id: c.id,
        body: c.body ?? '',
        author: c.user?.login ?? 'unknown',
        createdAt: c.created_at ?? '',
      }));
    }

    const prNumber = event.pullRequest?.number ?? (event.isPullRequest ? event.issue?.number : undefined);
    if (prNumber !== undefined) {
      if (!event.pullRequest || !event.pullRequest.headRef) {
        const { data: pr } = await this.api<{
          number: number; title: string; body?: string; user?: { login?: string }; state: string;
          head?: { ref?: string; sha?: string; repo?: { fork?: boolean } }; base?: { ref?: string };
        }>('GET', `${this.prefix}/pulls/${prNumber}`);
        if (pr) {
          context.pullRequest = {
            number: pr.number, title: pr.title, body: pr.body ?? '', author: pr.user?.login ?? 'unknown',
            labels: [], state: pr.state, headRef: pr.head?.ref ?? '', baseRef: pr.base?.ref ?? '',
            headSha: pr.head?.sha ?? '', fromFork: pr.head?.repo?.fork ?? false,
          } satisfies ForgePullRequest;
        }
      }
      const { data: files } = await this.api<
        { filename: string; status: string; additions: number; deletions: number }[]
      >('GET', `${this.prefix}/pulls/${prNumber}/files`);
      context.changedFiles = (files ?? []).map((f) => ({
        path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
      }));
      context.diff = await this.raw(`${this.prefix}/pulls/${prNumber}.diff`);
    }

    return context;
  }

  async resolveActor(login: string): Promise<ForgeActor> {
    const isBot = login.endsWith('[bot]');

    // Prefer org membership: it is readable by any member-level token, so crab'd can authorize a
    // commenter without the bot needing repo-admin. (Gitea gates the collaborator-permission
    // endpoint below behind admin, a heavy grant for a review bot.) An org member maps to MEMBER;
    // anyone else falls through to the repo permission level.
    try {
      const { status } = await this.api('GET', `/orgs/${this.repo.owner}/members/${encodeURIComponent(login)}`);
      if (status >= 200 && status < 300) return { login, association: 'MEMBER', isBot };
    } catch {
      // Membership unreadable (token lacks org scope, or the owner is a user not an org) — fall back.
    }

    // Fallback for user-owned repos and non-member collaborators. Reading another user's permission
    // requires the token to have repo-admin; if it can't, this throws and the caller (prepareRun)
    // fails safe to a denied NONE actor.
    const { data } = await this.api<{ permission?: string }>(
      'GET',
      `${this.prefix}/collaborators/${login}/permission`,
    );
    return { login, association: permissionToAssociation(data?.permission ?? 'none'), isBot };
  }

  async createTrackingComment(target: number, body: string): Promise<TrackingComment> {
    const { data } = await this.api<{ id: number }>('POST', `${this.prefix}/issues/${target}/comments`, { body });
    return { id: data?.id ?? 0, target };
  }

  async findTrackingComment(target: number): Promise<TrackingComment | undefined> {
    const { data } = await this.api<{ id: number; body?: string }[]>(
      'GET',
      `${this.prefix}/issues/${target}/comments`,
    );
    const existing = (data ?? []).find((c) => (c.body ?? '').includes(TRACKING_MARKER));
    return existing ? { id: existing.id, target } : undefined;
  }

  async updateTrackingComment(ref: TrackingComment, body: string): Promise<void> {
    await this.api('PATCH', `${this.prefix}/issues/comments/${ref.id}`, { body });
  }

  async reactToComment(commentId: number, reaction: string): Promise<void> {
    await this.api('POST', `${this.prefix}/issues/comments/${commentId}/reactions`, { content: reaction });
  }

  async postReview(prNumber: number, review: ReviewSubmission): Promise<void> {
    await this.api('POST', `${this.prefix}/pulls/${prNumber}/reviews`, {
      body: review.body,
      event: review.event,
      comments: review.comments?.map((c) => ({ path: c.path, body: c.body, new_position: c.line })),
    });
  }

  async commitToBranch(request: CommitRequest): Promise<void> {
    const baseBranch = request.baseBranch ?? this.repo.defaultBranch;

    // Create the branch from the base branch if it does not exist.
    const existing = await this.api('GET', `${this.prefix}/branches/${request.branch}`);
    if (existing.status === 404) {
      await this.api('POST', `${this.prefix}/branches`, {
        new_branch_name: request.branch,
        old_branch_name: baseBranch,
      });
    }

    for (const change of request.changes) {
      const path = `${this.prefix}/contents/${encodeURIComponent(change.path)}`;
      const current = await this.api<{ sha?: string }>(
        'GET',
        `${path}?ref=${encodeURIComponent(request.branch)}`,
      );
      const sha = current.status === 200 ? current.data?.sha : undefined;

      if (change.op === 'delete') {
        if (sha) await this.api('DELETE', path, { message: request.message, branch: request.branch, sha });
        continue;
      }

      const payload = {
        content: change.contentBase64 ?? '',
        message: request.message,
        branch: request.branch,
        ...(sha ? { sha } : {}),
      };
      await this.api(sha ? 'PUT' : 'POST', path, payload);
    }
  }

  async openOrUpdatePR(request: OpenPrRequest): Promise<PullRequestRef> {
    const { data: open } = await this.api<{ number: number; html_url: string; head?: { ref?: string } }[]>(
      'GET',
      `${this.prefix}/pulls?state=open`,
    );
    const match = (open ?? []).find((p) => p.head?.ref === request.headBranch);
    if (match) {
      await this.api('PATCH', `${this.prefix}/pulls/${match.number}`, { title: request.title, body: request.body });
      return { number: match.number, url: match.html_url };
    }
    const { data: created } = await this.api<{ number: number; html_url: string }>('POST', `${this.prefix}/pulls`, {
      title: request.title,
      body: request.body,
      head: request.headBranch,
      base: request.baseBranch,
    });
    return { number: created?.number ?? 0, url: created?.html_url ?? '' };
  }

  async readOrgConfig(repoSlug: string, path: string): Promise<string | undefined> {
    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) return undefined;
    const { status, data } = await this.api<{ content?: string; encoding?: string }>(
      'GET',
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(path)}`,
    );
    if (status !== 200 || !data?.content) return undefined;
    return Buffer.from(data.content, data.encoding === 'base64' ? 'base64' : 'utf-8').toString('utf-8');
  }
}

import type { AuthProvider } from '../auth/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import { foldCommentsIntoBody } from './review-body.ts';
import { buildReviewThread, groupReviewThreads, type RawReviewComment } from './review-thread.ts';
import { assertExpectedParent } from './commit-guard.ts';
import {
  DEFAULT_LOG_TAIL,
  describeCheckFailure,
  MAX_FAILED_LOGS,
  normalizeCheckConclusion,
  normalizeReviewState,
  tail,
} from './checks.ts';
import type {
  CheckSummary,
  ChecksSummary,
  CommitRequest,
  ForgeActor,
  ForgeAdapter,
  ForgeContext,
  ForgeEvent,
  ForgeKind,
  ForgePullRequest,
  ForgeRepo,
  ForgeReview,
  OpenPrRequest,
  PullRequestRef,
  ReviewSubmission,
  ReviewThreadSummary,
  TrackingComment,
} from './types.ts';

export interface ForgejoForgeOptions {
  auth: AuthProvider;
  repo: ForgeRepo;
  /** Forgejo API root, e.g. `https://forgejo.example.com/api/v1`. */
  baseUrl: string;
}

/** How many of a pull request's most recent reviews to pull inline comments from. */
const REVIEW_FETCH_LIMIT = 20;

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

  /**
   * A 404 is tolerated on a GET, where several callers use it as an existence probe (does this
   * branch exist, does this file exist). On a write it is an error: an endpoint that is not there
   * cannot have done anything, and swallowing it hid a reply path that silently did nothing.
   */
  private async api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T | undefined }> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: await this.headers(),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : undefined;
    const tolerate404 = method === 'GET' && res.status === 404;
    if (!res.ok && !tolerate404) {
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
          head?: { ref?: string; sha?: string; repo?: { fork?: boolean; full_name?: string } }; base?: { ref?: string };
          draft?: boolean;
        }>('GET', `${this.prefix}/pulls/${prNumber}`);
        if (pr) {
          const headRepoSlug = pr.head?.repo?.full_name;
          context.pullRequest = {
            number: pr.number, title: pr.title, body: pr.body ?? '', author: pr.user?.login ?? 'unknown',
            labels: [], state: pr.state, headRef: pr.head?.ref ?? '', baseRef: pr.base?.ref ?? '',
            headSha: pr.head?.sha ?? '',
            ...(headRepoSlug ? { headRepoSlug } : {}),
            fromFork: headRepoSlug ? headRepoSlug !== this.repo.slug : (pr.head?.repo?.fork ?? false),
            isDraft: pr.draft ?? false,
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

      if (event.kind === 'pull_request_review_comment' && event.comment) {
        const comments = await this.reviewComments(prNumber);
        if (comments.length > 0) {
          context.replyThread = buildReviewThread(comments, event.comment.id);
        }
      }
    }

    return context;
  }

  /**
   * Every inline review comment on a pull request.
   *
   * Forgejo has no flat "list all review comments" endpoint — comments hang off their review — so
   * this fans out over the reviews. Bounded to the most recent {@link REVIEW_FETCH_LIMIT} because
   * a long-lived pull request can accumulate a lot of them and this runs on every reply.
   *
   * Entirely best-effort: a failure here costs the model the thread around the comment it is
   * answering, not the run.
   */
  private async reviewComments(prNumber: number): Promise<RawReviewComment[]> {
    try {
      const { data: reviews } = await this.api<{ id: number }[]>('GET', `${this.prefix}/pulls/${prNumber}/reviews`);
      const recent = (reviews ?? []).slice(-REVIEW_FETCH_LIMIT);
      const collected: RawReviewComment[] = [];
      for (const review of recent) {
        const { data } = await this.api<RawReviewComment[]>(
          'GET',
          `${this.prefix}/pulls/${prNumber}/reviews/${review.id}/comments`,
        );
        if (data) collected.push(...data);
      }
      return collected;
    } catch {
      return [];
    }
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

  async findTrackingComment(target: number, marker: string = TRACKING_MARKER): Promise<TrackingComment | undefined> {
    const { data } = await this.api<{ id: number; body?: string }[]>(
      'GET',
      `${this.prefix}/issues/${target}/comments`,
    );
    const existing = (data ?? []).find((c) => (c.body ?? '').includes(marker));
    return existing ? { id: existing.id, target, body: existing.body } : undefined;
  }

  async updateTrackingComment(ref: TrackingComment, body: string): Promise<void> {
    await this.api('PATCH', `${this.prefix}/issues/comments/${ref.id}`, { body });
  }

  async reactToComment(commentId: number, reaction: string, _kind?: 'issue' | 'review'): Promise<void> {
    await this.api('POST', `${this.prefix}/issues/comments/${commentId}/reactions`, { content: reaction });
  }

  /**
   * Forgejo has no reply endpoint and no threading, so a reply is a one-comment review anchored to
   * the same place. `groupReviewThreads` reads those back as one thread by co-location, which is
   * how the reply reads as a reply. Falls back to a plain issue comment when the anchor is gone.
   */
  async replyToReviewComment(pullNumber: number, commentId: number, body: string): Promise<void> {
    const target = (await this.reviewComments(pullNumber)).find((c) => c.id === commentId);
    const line = target?.line ?? target?.original_line ?? target?.position ?? target?.original_position;
    if (!target?.path || line === undefined || line === null) {
      await this.api('POST', `${this.prefix}/issues/${pullNumber}/comments`, { body });
      return;
    }
    await this.postReview(pullNumber, {
      body: '',
      event: 'COMMENT',
      comments: [{ path: target.path, line, body }],
    });
  }

  async postReview(prNumber: number, review: ReviewSubmission): Promise<void> {
    const path = `${this.prefix}/pulls/${prNumber}/reviews`;
    const comments = review.comments ?? [];
    try {
      await this.api('POST', path, {
        body: review.body,
        event: review.event,
        comments: comments.map((c) => ({ path: c.path, body: c.body, new_position: c.line })),
      });
    } catch (err) {
      // Like GitHub, Forgejo rejects the review with 422 when an inline comment points outside the
      // diff. Retry once without inline comments, folding them into the body so the review lands.
      if (comments.length === 0 || !/→ 422\b/.test(String(err))) throw err;
      await this.api('POST', path, { body: foldCommentsIntoBody(review.body, comments), event: review.event });
    }
  }

  async listReviewThreads(prNumber: number): Promise<ReviewThreadSummary[]> {
    return groupReviewThreads(await this.reviewComments(prNumber));
  }

  async listReviews(prNumber: number): Promise<ForgeReview[]> {
    const { data } = await this.api<
      {
        id: number;
        state?: string;
        body?: string;
        user?: { login?: string };
        submitted_at?: string;
      }[]
    >('GET', `${this.prefix}/pulls/${prNumber}/reviews`);
    return (data ?? []).map((review) => ({
      id: review.id,
      state: normalizeReviewState(review.state),
      body: review.body ?? '',
      author: review.user?.login ?? 'unknown',
      submittedAt: review.submitted_at ?? '',
    }));
  }

  /** Forgejo has no resolve-conversation endpoint, in any version through v16. */
  async resolveReviewThread(_threadId: string): Promise<boolean> {
    return false;
  }

  async listChecks(sha: string, options?: { logTailBytes?: number }): Promise<ChecksSummary> {
    const checks: CheckSummary[] = [];
    try {
      const { data } = await this.api<{
        statuses?: { context?: string; status?: string; target_url?: string; description?: string }[];
      }>('GET', `${this.prefix}/commits/${sha}/status`);
      for (const status of data?.statuses ?? []) {
        checks.push({
          name: status.context ?? 'status',
          conclusion: normalizeCheckConclusion('completed', status.status),
          ...(status.target_url ? { url: status.target_url } : {}),
        });
      }
    } catch (error) {
      return { available: false, reason: describeCheckFailure(error), checks: [] };
    }

    try {
      const { data: runs } = await this.api<{ workflow_runs?: { id: number; status?: string; html_url?: string }[] }>(
        'GET',
        `${this.prefix}/actions/runs?head_sha=${encodeURIComponent(sha)}&limit=20`,
      );
      const tailBytes = options?.logTailBytes ?? DEFAULT_LOG_TAIL;
      let logged = 0;
      for (const run of runs?.workflow_runs ?? []) {
        const { data: jobs } = await this.api<{ id: number; name?: string; status?: string }[]>(
          'GET',
          `${this.prefix}/actions/runs/${run.id}/jobs`,
        );
        for (const job of jobs ?? []) {
          const conclusion = normalizeCheckConclusion(job.status, job.status);
          const name = job.name ?? `job ${job.id}`;
          const existing = checks.find((check) => check.name === name);
          const check = existing ?? { name, conclusion, ...(run.html_url ? { url: run.html_url } : {}) };
          if (!existing) checks.push(check);
          if (conclusion !== 'failure' || logged >= MAX_FAILED_LOGS) continue;
          const log = await this.raw(`${this.prefix}/actions/jobs/${job.id}/logs`);
          if (log) {
            check.logTail = tail(log, tailBytes);
            logged += 1;
          }
        }
      }
    } catch {
      // No Actions access, or none ran for this commit. The commit statuses above still stand.
    }

    return { available: true, checks };
  }

  async commitToBranch(request: CommitRequest): Promise<void> {
    const baseBranch = request.baseBranch ?? this.repo.defaultBranch;

    // Create the branch from the base branch if it does not exist.
    const existing = await this.api<{ commit?: { id?: string } }>('GET', `${this.prefix}/branches/${request.branch}`);
    if (existing.status !== 404) assertExpectedParent(request, existing.data?.commit?.id ?? '');
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

  async checkRepoAccess(repoSlug: string): Promise<'ok' | 'denied'> {
    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) return 'denied';
    const res = await fetch(`${this.baseUrl}/repos/${owner}/${repo}`, { headers: await this.headers() });
    if (res.ok) return 'ok';
    if (res.status === 401 || res.status === 403 || res.status === 404) return 'denied';
    throw new Error(`crabd forgejo: GET /repos/${owner}/${repo} → ${res.status}`);
  }
}

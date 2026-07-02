import { Octokit } from '@octokit/rest';
import type { AuthProvider } from '../auth/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import type {
  CommitRequest,
  ForgeActor,
  ForgeContext,
  ForgeEvent,
  ForgeKind,
  ForgeRepo,
  OpenPrRequest,
  PullRequestRef,
  ReviewSubmission,
  TrackingComment,
  ForgeAdapter,
} from './types.ts';

export interface GitHubForgeOptions {
  auth: AuthProvider;
  repo: ForgeRepo;
  /** GitHub API base URL (GitHub Enterprise). Defaults to public GitHub. */
  baseUrl?: string;
}

/** Best-effort mapping from a repo permission level to an author-association proxy. */
function permissionToAssociation(permission: string): string {
  switch (permission) {
    case 'admin':
      return 'OWNER';
    case 'maintain':
    case 'write':
      return 'COLLABORATOR';
    default:
      return 'NONE';
  }
}

export class GitHubForge implements ForgeAdapter {
  readonly kind: ForgeKind = 'github';
  readonly repo: ForgeRepo;
  private readonly auth: AuthProvider;
  private readonly baseUrl?: string;
  private client?: Octokit;

  constructor(options: GitHubForgeOptions) {
    this.auth = options.auth;
    this.repo = options.repo;
    this.baseUrl = options.baseUrl;
  }

  private async gh(): Promise<Octokit> {
    if (!this.client) {
      const token = await this.auth.getToken();
      this.client = new Octokit({ auth: token, ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}) });
    }
    return this.client;
  }

  private get owner(): string {
    return this.repo.owner;
  }
  private get name(): string {
    return this.repo.name;
  }

  async getContext(event: ForgeEvent): Promise<ForgeContext> {
    const gh = await this.gh();
    const base = { owner: this.owner, repo: this.name };
    const context: ForgeContext = {
      repo: this.repo,
      issue: event.issue,
      pullRequest: event.pullRequest,
      comments: [],
      changedFiles: [],
    };

    const subjectNumber = event.pullRequest?.number ?? event.issue?.number;
    if (subjectNumber !== undefined) {
      const { data: comments } = await gh.issues.listComments({ ...base, issue_number: subjectNumber, per_page: 100 });
      context.comments = comments.map((c) => ({
        id: c.id,
        body: c.body ?? '',
        author: c.user?.login ?? 'unknown',
        createdAt: c.created_at,
      }));
    }

    // Determine the PR number from a real PR event or an issue_comment on a PR.
    const prNumber =
      event.pullRequest?.number ?? (event.isPullRequest ? event.issue?.number : undefined);

    if (prNumber !== undefined) {
      // Enrich the PR (head/base refs, sha, fork flag) when we only had an issue view.
      if (!event.pullRequest || !event.pullRequest.headRef) {
        const { data: pr } = await gh.pulls.get({ ...base, pull_number: prNumber });
        context.pullRequest = {
          number: pr.number,
          title: pr.title,
          body: pr.body ?? '',
          author: pr.user?.login ?? 'unknown',
          labels: pr.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
          state: pr.state,
          headRef: pr.head.ref,
          baseRef: pr.base.ref,
          headSha: pr.head.sha,
          fromFork: pr.head.repo?.fork ?? false,
        };
      }

      const { data: files } = await gh.pulls.listFiles({ ...base, pull_number: prNumber, per_page: 100 });
      context.changedFiles = files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      const diff = await gh.pulls.get({ ...base, pull_number: prNumber, mediaType: { format: 'diff' } });
      // With the diff media type, `data` is the raw unified diff string.
      context.diff = diff.data as unknown as string;
    }

    return context;
  }

  async resolveActor(login: string): Promise<ForgeActor> {
    const gh = await this.gh();
    try {
      const { data } = await gh.repos.getCollaboratorPermissionLevel({
        owner: this.owner,
        repo: this.name,
        username: login,
      });
      return { login, association: permissionToAssociation(data.permission), isBot: login.endsWith('[bot]') };
    } catch {
      return { login, association: 'NONE', isBot: login.endsWith('[bot]') };
    }
  }

  async createTrackingComment(target: number, body: string): Promise<TrackingComment> {
    const gh = await this.gh();
    const { data } = await gh.issues.createComment({ owner: this.owner, repo: this.name, issue_number: target, body });
    return { id: data.id, target };
  }

  async findTrackingComment(target: number): Promise<TrackingComment | undefined> {
    const gh = await this.gh();
    const { data } = await gh.issues.listComments({
      owner: this.owner,
      repo: this.name,
      issue_number: target,
      per_page: 100,
    });
    const existing = data.find((c) => (c.body ?? '').includes(TRACKING_MARKER));
    return existing ? { id: existing.id, target } : undefined;
  }

  async updateTrackingComment(ref: TrackingComment, body: string): Promise<void> {
    const gh = await this.gh();
    await gh.issues.updateComment({ owner: this.owner, repo: this.name, comment_id: ref.id, body });
  }

  async reactToComment(commentId: number, reaction: string): Promise<void> {
    const gh = await this.gh();
    await gh.reactions.createForIssueComment({
      owner: this.owner,
      repo: this.name,
      comment_id: commentId,
      content: reaction as 'eyes',
    });
  }

  async postReview(prNumber: number, review: ReviewSubmission): Promise<void> {
    const gh = await this.gh();
    await gh.pulls.createReview({
      owner: this.owner,
      repo: this.name,
      pull_number: prNumber,
      body: review.body,
      event: review.event,
      comments: review.comments?.map((c) => ({ path: c.path, line: c.line, body: c.body })),
    });
  }

  /** Create a single commit containing all files via the git data API. */
  async commitToBranch(request: CommitRequest): Promise<void> {
    const gh = await this.gh();
    const base = { owner: this.owner, repo: this.name };
    const baseBranch = request.baseBranch ?? this.repo.defaultBranch;

    // Resolve the branch tip, creating the branch from the base branch if absent.
    let parentSha: string;
    try {
      const { data: ref } = await gh.git.getRef({ ...base, ref: `heads/${request.branch}` });
      parentSha = ref.object.sha;
    } catch {
      const { data: baseRef } = await gh.git.getRef({ ...base, ref: `heads/${baseBranch}` });
      parentSha = baseRef.object.sha;
      await gh.git.createRef({ ...base, ref: `refs/heads/${request.branch}`, sha: parentSha });
    }

    const { data: parentCommit } = await gh.git.getCommit({ ...base, commit_sha: parentSha });

    const tree = await Promise.all(
      request.changes.map(async (change) => {
        if (change.op === 'delete') {
          // A null sha in a tree entry removes the path.
          return { path: change.path, mode: '100644' as const, type: 'blob' as const, sha: null };
        }
        const { data: blob } = await gh.git.createBlob({
          ...base,
          content: change.contentBase64 ?? '',
          encoding: 'base64',
        });
        return { path: change.path, mode: '100644' as const, type: 'blob' as const, sha: blob.sha };
      }),
    );

    const { data: newTree } = await gh.git.createTree({ ...base, base_tree: parentCommit.tree.sha, tree });
    const { data: commit } = await gh.git.createCommit({
      ...base,
      message: request.message,
      tree: newTree.sha,
      parents: [parentSha],
    });
    await gh.git.updateRef({ ...base, ref: `heads/${request.branch}`, sha: commit.sha, force: false });
  }

  async openOrUpdatePR(request: OpenPrRequest): Promise<PullRequestRef> {
    const gh = await this.gh();
    const base = { owner: this.owner, repo: this.name };
    const { data: existing } = await gh.pulls.list({
      ...base,
      head: `${this.owner}:${request.headBranch}`,
      state: 'open',
    });
    const current = existing[0];
    if (current) {
      await gh.pulls.update({ ...base, pull_number: current.number, title: request.title, body: request.body });
      return { number: current.number, url: current.html_url };
    }
    const { data: created } = await gh.pulls.create({
      ...base,
      title: request.title,
      body: request.body,
      head: request.headBranch,
      base: request.baseBranch,
    });
    return { number: created.number, url: created.html_url };
  }

  async readOrgConfig(repoSlug: string, path: string): Promise<string | undefined> {
    const gh = await this.gh();
    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) return undefined;
    try {
      const { data } = await gh.repos.getContent({ owner, repo, path });
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') return undefined;
      return Buffer.from(data.content, 'base64').toString('utf-8');
    } catch {
      return undefined;
    }
  }
}

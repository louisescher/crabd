import { Octokit } from '@octokit/rest';
import type { AuthProvider } from '../auth/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import { foldCommentsIntoBody } from './review-body.ts';
import { buildReviewThread } from './review-thread.ts';
import { buildDiffFromFiles, type PullFilePatch } from './synth-diff.ts';
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

/** An Octokit `RequestError` carrying HTTP 422 (Unprocessable Entity). */
function isUnprocessableEntity(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { status?: number }).status === 422;
}

function isDiffTooLarge(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { status, message } = err as { status?: number; message?: string };
  return status === 406 || (message ?? '').includes('too_large');
}

const MAX_CHANGED_FILES = 1_000;

type PullFile = PullFilePatch & { additions: number; deletions: number };

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
          isDraft: pr.draft ?? false,
        };
      }

      const files: PullFile[] = [];
      for await (const page of gh.paginate.iterator(gh.pulls.listFiles, {
        ...base,
        pull_number: prNumber,
        per_page: 100,
      })) {
        files.push(...page.data);
        if (files.length >= MAX_CHANGED_FILES) break;
      }
      context.changedFiles = files.map((f) => ({
        path: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
      context.diff = await this.pullRequestDiff(prNumber, files);

      // A reply to an inline finding fires `pull_request_review_comment`, and the comment it answers
      // is not in `listComments` above — that's the issue-level timeline. Fetch the review comments
      // so the model can see what it is being corrected about.
      if (event.kind === 'pull_request_review_comment' && event.comment) {
        try {
          const { data: reviewComments } = await gh.pulls.listReviewComments({
            ...base,
            pull_number: prNumber,
            per_page: 100,
          });
          context.replyThread = buildReviewThread(reviewComments, event.comment.id);
        } catch {
          // Best-effort: the reply itself still reaches the prompt without its thread.
        }
      }
    }

    return context;
  }

  private async pullRequestDiff(prNumber: number, files: PullFilePatch[]): Promise<string> {
    const gh = await this.gh();
    try {
      const { data } = await gh.pulls.get({
        owner: this.owner,
        repo: this.name,
        pull_number: prNumber,
        mediaType: { format: 'diff' },
      });
      return data as unknown as string;
    } catch (err) {
      if (!isDiffTooLarge(err)) throw err;
      return buildDiffFromFiles(files);
    }
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

  async findTrackingComment(target: number, marker: string = TRACKING_MARKER): Promise<TrackingComment | undefined> {
    const gh = await this.gh();
    const { data } = await gh.issues.listComments({
      owner: this.owner,
      repo: this.name,
      issue_number: target,
      per_page: 100,
    });
    const existing = data.find((c) => (c.body ?? '').includes(marker));
    return existing ? { id: existing.id, target, body: existing.body ?? undefined } : undefined;
  }

  async updateTrackingComment(ref: TrackingComment, body: string): Promise<void> {
    const gh = await this.gh();
    await gh.issues.updateComment({ owner: this.owner, repo: this.name, comment_id: ref.id, body });
  }

  async reactToComment(commentId: number, reaction: string, kind: 'issue' | 'review' = 'issue'): Promise<void> {
    const gh = await this.gh();
    const base = { owner: this.owner, repo: this.name, content: reaction as 'eyes' };
    if (kind === 'review') {
      await gh.reactions.createForPullRequestReviewComment({ ...base, comment_id: commentId });
    } else {
      await gh.reactions.createForIssueComment({ ...base, comment_id: commentId });
    }
  }

  async replyToReviewComment(pullNumber: number, commentId: number, body: string): Promise<void> {
    const gh = await this.gh();
    await gh.pulls.createReplyForReviewComment({
      owner: this.owner,
      repo: this.name,
      pull_number: pullNumber,
      comment_id: commentId,
      body,
    });
  }

  async postReview(prNumber: number, review: ReviewSubmission): Promise<void> {
    const gh = await this.gh();
    const base = {
      owner: this.owner,
      repo: this.name,
      pull_number: prNumber,
      body: review.body,
      event: review.event,
    };
    const comments = review.comments ?? [];
    try {
      await gh.pulls.createReview({
        ...base,
        comments: comments.map((c) => ({ path: c.path, line: c.line, body: c.body })),
      });
    } catch (err) {
      // GitHub rejects the whole review with 422 "Line could not be resolved" if any inline
      // comment targets a line outside the diff. review mode filters these out ahead of time, but
      // as a last resort (renames, path mismatches) retry once without inline comments, folding
      // them into the body so the review — and its findings — still land instead of failing the run.
      if (comments.length === 0 || !isUnprocessableEntity(err)) throw err;
      await gh.pulls.createReview({ ...base, body: foldCommentsIntoBody(review.body, comments) });
    }
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

  async checkRepoAccess(repoSlug: string): Promise<'ok' | 'denied'> {
    const [owner, repo] = repoSlug.split('/');
    if (!owner || !repo) return 'denied';
    const gh = await this.gh();
    try {
      await gh.repos.get({ owner, repo });
      return 'ok';
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 401 || status === 403 || status === 404) return 'denied';
      throw error;
    }
  }
}

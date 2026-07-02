/**
 * Forge-agnostic domain model. GitHub and Forgejo both normalize their events and
 * API responses into these shapes so the rest of crab'd (trigger, context, policy,
 * modes) never depends on a specific forge.
 */

export type ForgeKind = 'github' | 'forgejo';

/** Reaction contents supported by both GitHub and Forgejo/Gitea. */
export type ForgeReaction = '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes';

/** A repository, identified portably as `owner/name`. */
export interface ForgeRepo {
  owner: string;
  name: string;
  /** `owner/name`. */
  slug: string;
  defaultBranch: string;
  isPrivate: boolean;
}

/**
 * The person who triggered the event, plus their relationship to the repo.
 * `association` uses GitHub's author-association vocabulary (OWNER, MEMBER,
 * COLLABORATOR, CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, NONE); Forgejo is mapped onto it.
 */
export interface ForgeActor {
  login: string;
  association: string;
  isBot: boolean;
}

export interface ForgeComment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface ForgeIssue {
  number: number;
  title: string;
  body: string;
  author: string;
  labels: string[];
  state: string;
}

export interface ForgePullRequest extends ForgeIssue {
  headRef: string;
  baseRef: string;
  headSha: string;
  /** Whether the PR originates from a fork (affects write permissions). */
  fromFork: boolean;
}

/** A changed file in a pull request. */
export interface ForgeChangedFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
}

/** The raw webhook/event kinds crab'd reacts to, normalized across forges. */
export type ForgeEventKind = 'issue_comment' | 'pull_request_review_comment' | 'issues' | 'pull_request';

/**
 * A normalized inbound event assembled from the CI event payload (`GITHUB_EVENT_PATH`)
 * and environment. This is the input to trigger detection.
 */
export interface ForgeEvent {
  forge: ForgeKind;
  kind: ForgeEventKind;
  /** e.g. `created`, `opened`, `synchronize`, `assigned`, `labeled`. */
  action: string;
  repo: ForgeRepo;
  actor: ForgeActor;
  /** Present for issue/PR-scoped events. */
  issue?: ForgeIssue;
  pullRequest?: ForgePullRequest;
  /** The comment that triggered the event, when applicable. */
  comment?: ForgeComment;
  /**
   * True when the subject is a pull request even though only an issue view is
   * present (e.g. an `issue_comment` on a PR). The adapter enriches `pullRequest`
   * in {@link ForgeAdapter.getContext}.
   */
  isPullRequest?: boolean;
  /** The original, un-normalized payload (for adapter-specific needs). */
  raw: unknown;
}

/** Everything crab'd fetches about the subject before running the agent. */
export interface ForgeContext {
  repo: ForgeRepo;
  issue?: ForgeIssue;
  pullRequest?: ForgePullRequest;
  comments: ForgeComment[];
  /** Unified diff for a PR, when applicable. */
  diff?: string;
  changedFiles: ForgeChangedFile[];
}

/** Handle to a posted tracking comment so it can be updated in place. */
export interface TrackingComment {
  id: number;
  /** Where the comment lives (issue or PR number). */
  target: number;
}

/** A single inline review finding. */
export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

export interface ReviewSubmission {
  body: string;
  event: 'COMMENT' | 'REQUEST_CHANGES' | 'APPROVE';
  comments?: ReviewComment[];
}

export type FileChangeOp = 'upsert' | 'delete';

/** A single file change to commit. Content is base64 so binary files pass through. */
export interface FileChange {
  path: string;
  op: FileChangeOp;
  /** Base64-encoded content. Required for `upsert`, absent for `delete`. */
  contentBase64?: string;
}

export interface CommitRequest {
  branch: string;
  message: string;
  changes: FileChange[];
  /** Base branch to create `branch` from when it does not yet exist. */
  baseBranch?: string;
}

export interface OpenPrRequest {
  title: string;
  body: string;
  headBranch: string;
  baseBranch: string;
}

export interface PullRequestRef {
  number: number;
  url: string;
}

/**
 * The single seam every forge implements. Trigger detection, context assembly, and
 * the modes talk only to this interface — never to Octokit or the Forgejo client.
 */
export interface ForgeAdapter {
  readonly kind: ForgeKind;
  readonly repo: ForgeRepo;

  /** Fetch the full context for the event's subject (issue/PR, comments, diff, files). */
  getContext(event: ForgeEvent): Promise<ForgeContext>;

  /** Resolve an actor's association/role for the repo (for the trust gate). */
  resolveActor(login: string): Promise<ForgeActor>;

  /** Post the initial "crab'd is working..." comment. */
  createTrackingComment(target: number, body: string): Promise<TrackingComment>;

  /** Find an existing crab'd tracking comment on the subject (by hidden marker), if any. */
  findTrackingComment(target: number): Promise<TrackingComment | undefined>;

  /** Add a reaction (e.g. `eyes`) to a comment — a fast acknowledgment of a trigger. */
  reactToComment(commentId: number, reaction: ForgeReaction): Promise<void>;

  /** Update the tracking comment in place. */
  updateTrackingComment(ref: TrackingComment, body: string): Promise<void>;

  /** Submit a PR review (summary + optional inline comments). */
  postReview(prNumber: number, review: ReviewSubmission): Promise<void>;

  /** Commit file changes to a branch, creating it from `baseBranch` if needed. */
  commitToBranch(request: CommitRequest): Promise<void>;

  /** Open a PR, or update the existing one for the same head branch. */
  openOrUpdatePR(request: OpenPrRequest): Promise<PullRequestRef>;

  /**
   * Read a config file from another repo in the org (the org config repo).
   * Returns `undefined` when the file or repo is absent/unreadable.
   */
  readOrgConfig(repoSlug: string, path: string): Promise<string | undefined>;
}

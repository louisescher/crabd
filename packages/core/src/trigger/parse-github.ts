import type {
  ForgeEvent,
  ForgeEventKind,
  ForgeIssue,
  ForgePullRequest,
  ForgeRepo,
} from '../forge/types.ts';

// Minimal structural views of the GitHub webhook payload — parsed defensively so
// Forgejo's GitHub-compatible payloads flow through the same path.
interface RawUser {
  login?: string;
  type?: string;
}
interface RawRepo {
  name?: string;
  full_name?: string;
  owner?: { login?: string };
  default_branch?: string;
  private?: boolean;
}
interface RawComment {
  id?: number;
  body?: string;
  user?: RawUser;
  created_at?: string;
  author_association?: string;
}
interface RawIssue {
  number?: number;
  title?: string;
  body?: string | null;
  user?: RawUser;
  labels?: (string | { name?: string })[];
  state?: string;
  author_association?: string;
  pull_request?: unknown;
}
interface RawPull extends RawIssue {
  head?: { ref?: string; sha?: string; repo?: { fork?: boolean } };
  base?: { ref?: string };
}
interface RawPayload {
  action?: string;
  repository?: RawRepo;
  sender?: RawUser;
  comment?: RawComment;
  issue?: RawIssue;
  pull_request?: RawPull;
}

const EVENT_KINDS: Record<string, ForgeEventKind> = {
  issue_comment: 'issue_comment',
  pull_request_review_comment: 'pull_request_review_comment',
  issues: 'issues',
  pull_request: 'pull_request',
};

function labelNames(labels: RawIssue['labels']): string[] {
  if (!labels) return [];
  return labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean);
}

function normalizeIssue(raw: RawIssue): ForgeIssue {
  return {
    number: raw.number ?? 0,
    title: raw.title ?? '',
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    labels: labelNames(raw.labels),
    state: raw.state ?? 'open',
  };
}

function normalizePull(raw: RawPull): ForgePullRequest {
  return {
    ...normalizeIssue(raw),
    headRef: raw.head?.ref ?? '',
    baseRef: raw.base?.ref ?? '',
    headSha: raw.head?.sha ?? '',
    fromFork: raw.head?.repo?.fork ?? false,
  };
}

function buildRepo(raw: RawRepo | undefined): ForgeRepo {
  const owner = raw?.owner?.login;
  const name = raw?.name;
  if (!owner || !name) throw new Error('crabd: event payload missing repository owner/name');
  return {
    owner,
    name,
    slug: raw?.full_name ?? `${owner}/${name}`,
    defaultBranch: raw?.default_branch ?? 'main',
    isPrivate: raw?.private ?? true,
  };
}

/**
 * Normalize a GitHub (or Forgejo, GitHub-compatible) webhook payload into a
 * {@link ForgeEvent}. Returns `null` for event names crab'd does not handle.
 */
export function parseGitHubEvent(eventName: string, payload: unknown, forge: 'github' | 'forgejo' = 'github'): ForgeEvent | null {
  const kind = EVENT_KINDS[eventName];
  if (!kind) return null;

  const p = payload as RawPayload;
  const repo = buildRepo(p.repository);

  const associationSource = p.comment?.author_association ?? p.issue?.author_association ?? p.pull_request?.author_association;
  const actorLogin = p.sender?.login ?? p.comment?.user?.login ?? 'unknown';
  const actor = {
    login: actorLogin,
    association: associationSource ?? 'NONE',
    isBot: (p.sender?.type ?? '').toLowerCase() === 'bot' || actorLogin.endsWith('[bot]'),
  };

  const event: ForgeEvent = {
    forge,
    kind,
    action: p.action ?? '',
    repo,
    actor,
    raw: payload,
  };

  if (p.comment) {
    event.comment = {
      id: p.comment.id ?? 0,
      body: p.comment.body ?? '',
      author: p.comment.user?.login ?? actorLogin,
      createdAt: p.comment.created_at ?? '',
    };
  }

  if (p.pull_request) {
    event.pullRequest = normalizePull(p.pull_request);
  }

  if (p.issue) {
    event.issue = normalizeIssue(p.issue);
    // An issue_comment on a PR carries a `pull_request` marker on the issue.
    if (p.issue.pull_request) event.isPullRequest = true;
  }

  return event;
}

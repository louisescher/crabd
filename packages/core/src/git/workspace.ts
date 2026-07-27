import { execFileSync } from 'node:child_process';

/** Run a git command, returning `undefined` instead of throwing when it fails. */
function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return undefined;
  }
}

/**
 * What the agent's checkout actually contains, resolved from git rather than assumed from the
 * event payload.
 *
 * This matters because crab'd's most common trigger is `issue_comment` ("@crabd review this"),
 * and on that event `GITHUB_SHA` is the *default branch* — a plain `actions/checkout` therefore
 * leaves the runner on main, not on the pull request. Every file the model opens would then be
 * the wrong version while the diff in its prompt describes the PR, which produces confidently
 * wrong findings. {@link resolveWorkspace} detects that and {@link checkoutPrHead} tries to fix
 * it; when it can't, the prompt says so out loud (see `renderWorkspace` in `context/assemble.ts`).
 */
export interface WorkspaceState {
  /** Checked-out branch, or `undefined` when detached (the normal state after a ref checkout). */
  branch?: string;
  /** Resolved `HEAD` sha of the checkout. Absent when `cwd` is not a git repository. */
  headSha?: string;
  /** `git status --short` output; empty string when the tree is clean. */
  status: string;
  /** Subject lines of the most recent commits, newest first. */
  recentCommits: string[];
  /**
   * Whether {@link headSha} matches the pull request's head. `undefined` when there is no PR
   * to compare against (an issue event) or when either sha could not be resolved.
   */
  matchesPrHead?: boolean;
  /** The PR head sha this state was compared against, when one was supplied. */
  expectedHeadSha?: string;
}

/** How many recent commits to surface in the prompt. */
const RECENT_COMMITS = 5;

/** Read the checkout's VCS state, optionally comparing it to the pull request's head sha. */
export function resolveWorkspace(cwd: string, expectedHeadSha?: string): WorkspaceState {
  const headSha = tryGit(['rev-parse', 'HEAD'], cwd);
  // `--quiet` exits non-zero when detached, which tryGit turns into undefined — exactly right.
  const branch = tryGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const status = tryGit(['status', '--short'], cwd) ?? '';
  const log = tryGit(['log', `-${RECENT_COMMITS}`, '--no-decorate', '--format=%h %s'], cwd);

  const state: WorkspaceState = {
    ...(branch ? { branch } : {}),
    ...(headSha ? { headSha } : {}),
    status,
    recentCommits: log ? log.split('\n').filter(Boolean) : [],
  };

  if (expectedHeadSha) {
    state.expectedHeadSha = expectedHeadSha;
    if (headSha) state.matchesPrHead = headSha === expectedHeadSha;
  }
  return state;
}

/**
 * Best-effort: move the checkout onto the pull request's head commit.
 *
 * Tries fetching the sha directly first (works on GitHub and Forgejo when the server allows
 * fetching arbitrary objects), then the `refs/pull/N/head` ref, which is what a shallow CI
 * checkout can usually reach. Returns whether the checkout now sits on `headSha`. Never throws —
 * a failure leaves the tree as it was and is reported in the prompt instead.
 *
 * Refuses to touch a dirty tree. A consumer's workflow may legitimately have produced files
 * before the crab'd step (a build, a codegen step, a restored cache), and silently discarding
 * those to fix our own ref is a worse outcome than reviewing from the diff and saying so. The
 * checkout is deliberately *not* forced for the same reason.
 */
export function checkoutPrHead(cwd: string, headSha: string, prNumber?: number): boolean {
  if ((tryGit(['status', '--short'], cwd) ?? '').trim()) return false;

  const attempts: string[][] = [['fetch', '--depth=1', 'origin', headSha]];
  if (prNumber !== undefined) {
    attempts.push(['fetch', '--depth=1', 'origin', `refs/pull/${prNumber}/head`]);
  }

  for (const fetch of attempts) {
    if (tryGit(fetch, cwd) === undefined) continue;
    // Detach onto the sha itself rather than FETCH_HEAD so the result is unambiguous.
    if (tryGit(['checkout', '--detach', headSha], cwd) === undefined) continue;
    if (tryGit(['rev-parse', 'HEAD'], cwd) === headSha) return true;
  }
  return false;
}

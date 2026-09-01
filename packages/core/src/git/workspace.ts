import { execFileSync } from 'node:child_process';
import { debug, warn } from '../logger.ts';

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
  /**
   * Whether the checkout *contains* the pull request's head, even when {@link headSha} isn't it.
   *
   * The case that matters is `refs/pull/N/merge`, the ref both forges hand you by default on a
   * `pull_request` event, and what the workflow templates used to ask for on `issue_comment`. Its
   * sha is a merge commit, so it never equals the PR head, but the changes under review *are* in
   * the tree. Treating that as "wrong checkout" is what made crab'd review from the diff alone
   * while sitting on a perfectly good workspace.
   */
  containsPrHead?: boolean;
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
    if (headSha) {
      state.matchesPrHead = headSha === expectedHeadSha;
      // `--is-ancestor` exits 0 when the PR head is reachable from HEAD, which covers both the
      // merge-ref checkout and a tree that has moved on past the head commit. It exits non-zero
      // when the object isn't there at all, so a shallow checkout answers "no" rather than lying.
      state.containsPrHead =
        state.matchesPrHead || tryGit(['merge-base', '--is-ancestor', expectedHeadSha, 'HEAD'], cwd) !== undefined;
    }
  }
  debug(
    () =>
      `workspace: head=${state.headSha ?? '(unresolved)'} matchesPrHead=${state.matchesPrHead ?? 'n/a'} containsPrHead=${state.containsPrHead ?? 'n/a'}`,
  );
  return state;
}

/** Detach onto a sha, reporting whether HEAD actually ended up there. */
function detachOnto(cwd: string, headSha: string): boolean {
  if (tryGit(['checkout', '--detach', headSha], cwd) === undefined) return false;
  return tryGit(['rev-parse', 'HEAD'], cwd) === headSha;
}

/**
 * Best-effort: move the checkout onto the pull request's head commit.
 *
 * Checks for the commit locally first: on the merge-ref checkout that both forges default to, the
 * PR head is a parent of the commit already in the tree, so this is a pure `git checkout` with no
 * network involved. Only then does it fetch: the sha directly (works on GitHub and Forgejo when the
 * server allows fetching arbitrary objects), then `refs/pull/N/head`, which is what a shallow CI
 * checkout can usually reach. Returns whether the checkout now sits on `headSha`. Never throws —
 * a failure leaves the tree as it was and is reported in the prompt instead.
 *
 * Refuses to move a tree with *tracked* modifications. A consumer's workflow may legitimately have
 * produced files before the crab'd step (a build, a codegen step, a restored cache), and silently
 * discarding those to fix our own ref is a worse outcome than reviewing from the diff and saying
 * so. The checkout is deliberately *not* forced for the same reason. Untracked files are ignored
 * here because a non-forced checkout leaves them alone: refusing on those meant one stray artifact
 * in the workspace (a cloud-auth step's credentials file, say) blocked the fix for no reason.
 */
export function checkoutPrHead(cwd: string, headSha: string, prNumber?: number): boolean {
  debug(() => `checkoutPrHead: attempting ${headSha} (PR #${prNumber ?? '?'})`);

  if ((tryGit(['status', '--porcelain', '--untracked-files=no'], cwd) ?? '').trim()) {
    warn(`checkoutPrHead: tracked modifications present in ${cwd}, leaving the checkout as-is rather than discarding them`);
    return false;
  }

  // Already in the object store (merge-ref checkout, or full history of the head branch).
  if (tryGit(['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`], cwd) && detachOnto(cwd, headSha)) {
    return true;
  }

  const attempts: string[][] = [['fetch', '--depth=1', 'origin', headSha]];
  if (prNumber !== undefined) {
    attempts.push(['fetch', '--depth=1', 'origin', `refs/pull/${prNumber}/head`]);
  }

  for (const fetch of attempts) {
    if (tryGit(fetch, cwd) === undefined) continue;
    // Detach onto the sha itself rather than FETCH_HEAD so the result is unambiguous.
    if (detachOnto(cwd, headSha)) return true;
  }
  warn(`checkoutPrHead: could not check out PR head ${headSha}, falling back to the current checkout`);
  return false;
}

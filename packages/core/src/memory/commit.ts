import type { MemoryWrite } from '@crabd/config';
import type { ForgeAdapter, ForgeContext } from '../forge/types.ts';
import { changesForPaths } from '../git/changes.ts';
import { renderVetFailureMessage, scanForSecrets } from '../git/vet.ts';
import { debug, warn } from '../logger.ts';

/** Branch a `pr`-target memory commit lands on before its pull request is opened. */
const MEMORY_BRANCH = 'crabd/memory';

/** Where a recorded memory should be committed, or why it can't be. */
export type MemoryTarget =
  | { kind: 'branch'; branch: string }
  | { kind: 'pr'; branch: string; baseBranch: string }
  | { kind: 'main'; branch: string }
  | { kind: 'skip'; reason: string };

/**
 * Resolve where a memory goes for this run.
 *
 * Two cases are decided here rather than discovered as a 403 halfway through a commit:
 *
 * - **`branch` with no pull request.** A mention on an issue has no head branch to target, so it
 *   falls back to a dedicated pull request. Deliberately never to the default branch: the user
 *   asked for a review-gated write, and silently escalating to an unreviewed one is the wrong
 *   reading of that.
 * - **`branch` on a fork.** crab'd's token is scoped to the base repository and cannot push to a
 *   contributor's fork. Skipping with an explanation beats a failed push after the model has
 *   already composed the memory — and, again, redirecting to the base repo would quietly upgrade
 *   the write past the review the setting asked for.
 */
export function resolveMemoryTarget(write: MemoryWrite, context: ForgeContext): MemoryTarget {
  const defaultBranch = context.repo.defaultBranch;
  const dedicatedPr: MemoryTarget = { kind: 'pr', branch: MEMORY_BRANCH, baseBranch: defaultBranch };

  if (write === 'off') return { kind: 'skip', reason: 'memory writes are turned off (`memory.write: off`)' };
  if (write === 'main') return { kind: 'main', branch: defaultBranch };
  if (write === 'pr') return dedicatedPr;

  const pr = context.pullRequest;
  if (!pr || !pr.headRef) return dedicatedPr;
  if (pr.fromFork) {
    return {
      kind: 'skip',
      reason:
        "this pull request comes from a fork, and crab'd cannot push to a fork's branch. Set `memory.write: pr` to record memories in a separate pull request instead",
    };
  }
  return { kind: 'branch', branch: pr.headRef };
}

export interface CommitMemoriesInput {
  adapter: ForgeAdapter;
  context: ForgeContext;
  /**
   * Root the recorded memories were staged under — deliberately *not* the checkout.
   *
   * A memory is a side effect of the conversation, not part of the change the run was asked to
   * make. Staging it outside the working tree is what keeps a mode that commits its working
   * changes (`mention`, `implement`, or any custom mode calling `commitWorkingChanges`) from
   * sweeping the memory into its own commit and landing it on two branches at once.
   */
  sourceRoot: string;
  /** Repo-relative paths the `remember` tool wrote during the turn. */
  paths: string[];
  write: MemoryWrite;
  /** `config.permissions.write`. An explicit false refuses rather than committing. */
  writesAllowed: boolean;
  secretScan?: boolean;
}

export interface CommitMemoriesResult {
  /** A line for the tracking comment describing what happened, or undefined when nothing did. */
  note?: string;
  /** URL of the memory pull request, when one was opened. */
  prUrl?: string;
}

/**
 * Commit the memories recorded during this run.
 *
 * Best-effort by design: a memory that fails to land must not fail a review the user is waiting on.
 * Every outcome — committed, skipped, failed — comes back as a note for the tracking comment, so
 * the result is always visible rather than silently dropped.
 */
export async function commitMemories(input: CommitMemoriesInput): Promise<CommitMemoriesResult> {
  const paths = [...new Set(input.paths)].filter(Boolean);
  if (paths.length === 0) return {};

  const count = `${paths.length} memor${paths.length === 1 ? 'y' : 'ies'}`;
  if (!input.writesAllowed) {
    warn(`commitMemories: recorded ${count} but writes are disabled, not committing`);
    return { note: `🧠 Recorded ${count}, but could not commit: writes are turned off for this repository.` };
  }

  const target = resolveMemoryTarget(input.write, input.context);
  if (target.kind === 'skip') {
    warn(`commitMemories: recorded ${count} but skipping, ${target.reason}`);
    return { note: `🧠 Recorded ${count}, but could not commit: ${target.reason}.` };
  }

  const changes = changesForPaths(input.sourceRoot, paths);

  if (input.secretScan !== false) {
    const vet = scanForSecrets(changes);
    if (!vet.ok) {
      warn(`commitMemories: blocked ${count}, ${renderVetFailureMessage(vet)}`);
      return { note: `🧠 Recorded ${count}, but did not commit: ${renderVetFailureMessage(vet)}` };
    }
  }

  const message = `crab'd: record ${count} from review feedback`;
  debug(`commitMemories: committing ${count} to ${target.kind === 'pr' ? `${target.branch} (PR into ${target.baseBranch})` : target.branch}`);

  try {
    await input.adapter.commitToBranch({
      branch: target.branch,
      message,
      changes,
      ...(target.kind === 'pr' ? { baseBranch: target.baseBranch } : {}),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { note: `🧠 Recorded ${count}, but the commit failed: ${detail}` };
  }

  debug(`commitMemories: committed ${count} to ${target.branch}`);
  const list = paths.map((p) => `\`${p}\``).join(', ');

  if (target.kind === 'pr') {
    try {
      const pr = await input.adapter.openOrUpdatePR({
        title: "crab'd: record what I learned",
        body: [
          `Recorded ${count} after feedback on a previous run.`,
          '',
          'Each file under the memory directory is loaded into every future run as a settled ruling',
          'for this repository. Merge to accept, close to reject, or edit before merging.',
          '',
          list,
        ].join('\n'),
        headBranch: target.branch,
        baseBranch: target.baseBranch,
      });
      return { note: `🧠 Recorded ${count} (${list}) — see ${pr.url}.`, prUrl: pr.url };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { note: `🧠 Committed ${count} to \`${target.branch}\`, but opening the pull request failed: ${detail}` };
    }
  }

  return { note: `🧠 Recorded ${count} (${list}) on \`${target.branch}\`.` };
}

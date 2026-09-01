import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { ForgeAdapter } from '../forge/types.ts';
import { type Baseline, collectChangesSinceBaseline, hasChanges } from '../git/changes.ts';
import { renderVetFailureMessage, scanForSecrets } from '../git/vet.ts';
import { log } from '../logger.ts';

/** The issue/PR number the event concerns. */
export function subjectNumber(context: ForgeContext, event: ForgeEvent): number | undefined {
  return context.pullRequest?.number ?? context.issue?.number ?? event.pullRequest?.number ?? event.issue?.number;
}

export interface CommitOptions {
  adapter: ForgeAdapter;
  cwd: string;
  branch: string;
  message: string;
  baseBranch?: string;
  /**
   * `config.permissions.write`. Optional only so custom modes written against the old signature
   * still compile; pass it. An explicit `false` throws rather than committing.
   */
  writesAllowed?: boolean;
  baseline: Baseline;
  secretScan?: boolean;
}

/**
 * Commit the working-tree changes the model made to `branch` via the forge API.
 * Returns `false` (committing nothing) when the working tree is clean.
 *
 * The last line of defense for `permissions.write`: modes are expected to check it themselves and
 * say something useful, but every write funnels through here, so a mode that forgets fails loudly
 * instead of pushing.
 */
export async function commitWorkingChanges(options: CommitOptions): Promise<boolean> {
  if (options.writesAllowed === false) {
    throw new Error('crabd: refusing to commit: writes are disabled for this repository (permissions.write: false)');
  }
  if (!hasChanges(options.cwd)) return false;
  const changes = collectChangesSinceBaseline(options.cwd, options.baseline);
  if (changes.length === 0) return false;

  if (options.secretScan !== false) {
    const vet = scanForSecrets(changes);
    if (!vet.ok) {
      throw new Error(`crabd: refusing to commit, ${renderVetFailureMessage(vet)}`);
    }
  }

  await options.adapter.commitToBranch({
    branch: options.branch,
    message: options.message,
    changes,
    baseBranch: options.baseBranch,
  });
  log(`committed ${changes.length} change(s) to \`${options.branch}\``);
  return true;
}

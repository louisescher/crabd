import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { ForgeAdapter } from '../forge/types.ts';
import { collectChanges, hasChanges } from '../git/changes.ts';

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
}

/**
 * Commit the working-tree changes the model made to `branch` via the forge API.
 * Returns `false` (committing nothing) when the working tree is clean.
 */
export async function commitWorkingChanges(options: CommitOptions): Promise<boolean> {
  if (!hasChanges(options.cwd)) return false;
  const changes = collectChanges(options.cwd);
  if (changes.length === 0) return false;
  await options.adapter.commitToBranch({
    branch: options.branch,
    message: options.message,
    changes,
    baseBranch: options.baseBranch,
  });
  return true;
}

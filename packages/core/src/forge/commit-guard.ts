import type { CommitRequest } from './types.ts';

/**
 * Thrown when a branch has moved since the run read it. A distinct type because the adapters
 * resolve the tip inside a `try` whose `catch` is the ordinary "branch does not exist yet" path.
 */
export class BranchMovedError extends Error {}

export function assertExpectedParent(request: CommitRequest, parentSha: string): void {
  if (!request.expectedParentSha || request.expectedParentSha === parentSha) return;
  const from = request.expectedParentSha.slice(0, 8);
  const to = parentSha.slice(0, 8) || 'an unknown commit';
  throw new BranchMovedError(
    `crabd: refusing to commit: \`${request.branch}\` moved from ${from} to ${to} during this run. Nothing was committed.`,
  );
}

import { PR_MARKER } from '../report/tracking.ts';
import type { ForgeContext, ForgeEvent, ForgePullRequest } from './types.ts';

export const DEFAULT_BRANCH_PREFIX = 'crabd/';

export type ImplementPhase = 'issue' | 'round';

export function isCrabdPullRequest(
  pr: Pick<ForgePullRequest, 'body' | 'headRef'> | undefined,
  branchPrefix: string = DEFAULT_BRANCH_PREFIX,
): boolean {
  if (!pr) return false;
  if (pr.body.includes(PR_MARKER)) return true;
  return branchPrefix.length > 0 && pr.headRef.startsWith(branchPrefix);
}

export function implementPhase(context: ForgeContext, event: ForgeEvent): ImplementPhase {
  const isPullRequest = Boolean(context.pullRequest ?? event.pullRequest) || event.isPullRequest === true;
  return isPullRequest ? 'round' : 'issue';
}

export function brandPrBody(body: string): string {
  return body.includes(PR_MARKER) ? body : `${body.trimEnd()}\n\n${PR_MARKER}`;
}

export function forceBranchPrefix(branch: string, branchPrefix: string = DEFAULT_BRANCH_PREFIX): string {
  const trimmed = branch.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed.length === 0) return branchPrefix;
  if (branchPrefix.length === 0 || trimmed.startsWith(branchPrefix)) return trimmed;
  return `${branchPrefix}${trimmed}`;
}

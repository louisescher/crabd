import type { CheckConclusion, ForgeReviewState } from './types.ts';

export const DEFAULT_LOG_TAIL = 4_000;
export const MAX_FAILED_LOGS = 5;

export function tail(text: string, budget: number): string {
  const trimmed = text.trimEnd();
  if (trimmed.length <= budget) return trimmed;
  return `...(earlier output omitted)\n${trimmed.slice(-budget)}`;
}

const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'error']);
const PENDING_CONCLUSIONS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'running', 'blocked']);

export function normalizeCheckConclusion(status: string | null | undefined, conclusion: string | null | undefined): CheckConclusion {
  const state = (conclusion ?? '').toLowerCase();
  if (FAILURE_CONCLUSIONS.has(state)) return 'failure';
  if (state === 'success') return 'success';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'skipped' || state === 'neutral') return 'skipped';
  const phase = (status ?? '').toLowerCase();
  if (PENDING_CONCLUSIONS.has(phase) || PENDING_CONCLUSIONS.has(state)) return 'pending';
  if (phase === 'completed' && state === '') return 'unknown';
  return 'unknown';
}

const REVIEW_STATES: Record<string, ForgeReviewState> = {
  approved: 'approved',
  changes_requested: 'changes_requested',
  request_changes: 'changes_requested',
  rejected: 'changes_requested',
  commented: 'commented',
  comment: 'commented',
  dismissed: 'dismissed',
  pending: 'pending',
};

export function normalizeReviewState(state: string | null | undefined): ForgeReviewState {
  return REVIEW_STATES[(state ?? '').toLowerCase().replace(/\s+/g, '_')] ?? 'commented';
}

/**
 * Why the check state could not be read. A missing permission is the common case and the only one
 * a repository owner can act on, so it is named rather than reported as a generic failure.
 */
export function describeCheckFailure(error: unknown): string {
  const status = (error as { status?: number } | null)?.status;
  if (status === 403 || status === 401) {
    return "crab'd's token cannot read check runs for this repository. Grant `checks: read` (and `actions: read` for job logs) on the installation.";
  }
  if (status === 404) return 'no check runs are visible for this commit.';
  const message = error instanceof Error ? error.message : String(error);
  return `the check runs could not be read: ${message}`;
}

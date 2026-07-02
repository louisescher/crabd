import type { ResolvedConfig } from '@crabd/config';
import type { ForgeAdapter, ForgeContext, ForgeEvent } from '../forge/types.ts';
import { getMode, type FinalizeResult } from '../modes/registry.ts';
import { renderError, renderResult } from '../report/tracking.ts';
import type { TriggerResult } from '../trigger/detect.ts';
import type { RunPlan } from './prepare.ts';

export interface FinalizeInput {
  adapter: ForgeAdapter;
  config: ResolvedConfig;
  event: ForgeEvent;
  context: ForgeContext;
  trigger: TriggerResult;
  plan: RunPlan;
  /** The validated structured output produced by the model in the Flue phase. */
  data: unknown;
  /** Working directory of the checked-out repo. */
  cwd: string;
}

/**
 * Phase 3 (plain Node): run the mode's `finalize` (forge side effects) and update
 * the tracking comment with the result. On failure, the tracking comment is updated
 * with the error before rethrowing.
 */
export async function finalizeRun(input: FinalizeInput): Promise<FinalizeResult> {
  const { adapter, config, event, context, trigger, plan, data, cwd } = input;
  const mode = getMode(plan.mode);
  if (!mode) throw new Error(`crabd: no mode registered for "${plan.mode}"`);

  try {
    const result = await mode.finalize({ adapter, config, event, context, trigger, data, cwd });
    await adapter.updateTrackingComment(
      plan.tracking,
      // Use the mode's short tracking text when it posted its detail elsewhere (e.g. a PR review).
      renderResult({ mode: plan.mode, summary: result.trackingComment ?? result.summary, prUrl: result.prUrl }),
    );
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await adapter.updateTrackingComment(plan.tracking, renderError(plan.mode, message));
    throw error;
  }
}

/** Update the tracking comment with an error message (e.g. when the model run itself fails). */
export async function reportRunError(
  adapter: ForgeAdapter,
  plan: RunPlan,
  message: string,
): Promise<void> {
  await adapter.updateTrackingComment(plan.tracking, renderError(plan.mode, message));
}

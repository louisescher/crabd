import type { ResolvedConfig } from '@crabd/config';
import type { ForgeAdapter, ForgeContext, ForgeEvent } from '../forge/types.ts';
import { commitMemories } from '../memory/commit.ts';
import { getMode, type FinalizeResult } from '../modes/registry.ts';
import { renderFailure, renderResult, type FailureRender } from '../report/tracking.ts';
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
  /** Optional disclosure appended to the result comment (e.g. a fallback model was used). */
  note?: string;
  /**
   * Memories the turn's `remember` tool recorded: the staging root they were written under, and
   * their repo-relative paths. Staged outside the checkout so a mode committing its working-tree
   * changes cannot sweep them up — see `CommitMemoriesInput.sourceRoot`.
   */
  memories?: { root: string; paths: string[] };
}

/**
 * Phase 3 (plain Node): run the mode's `finalize` (forge side effects) and update
 * the tracking comment with the result. On failure, the tracking comment is updated
 * with the error before rethrowing.
 */
export async function finalizeRun(input: FinalizeInput): Promise<FinalizeResult> {
  const { adapter, config, event, context, trigger, plan, data, cwd, note } = input;
  const mode = getMode(plan.mode);
  if (!mode) throw new Error(`crabd: no mode registered for "${plan.mode}"`);

  try {
    const result = await mode.finalize({
      adapter,
      config,
      event,
      context,
      trigger,
      data,
      cwd,
      ...(plan.workspace ? { workspace: plan.workspace } : {}),
    });

    // After the mode, so a memory commit can never disturb the change the run was actually asked to
    // make — and so a failure to record cannot cost the user their review.
    const memory = await commitMemories({
      adapter,
      context,
      sourceRoot: input.memories?.root ?? cwd,
      paths: input.memories?.paths ?? [],
      write: config.memory.write,
      writesAllowed: config.permissions.write,
    });

    await adapter.updateTrackingComment(
      plan.tracking,
      // Use the mode's short tracking text when it posted its detail elsewhere (e.g. a PR review).
      renderResult(plan.branding, {
        mode: plan.mode,
        summary: memory.note
          ? `${result.trackingComment ?? result.summary}\n\n${memory.note}`
          : (result.trackingComment ?? result.summary),
        prUrl: result.prUrl,
        ...(note ? { note } : {}),
      }),
    );
    return memory.note ? { ...result, summary: `${result.summary}\n\n${memory.note}` } : result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await adapter.updateTrackingComment(
      plan.tracking,
      renderFailure(plan.branding, {
        mode: plan.mode,
        kind: 'error',
        detail: message,
        ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
      }),
    );
    throw error;
  }
}

/**
 * Update the tracking comment with a helpful, kind-aware failure message (e.g. when the
 * model run itself fails). Defaults to a generic error; pass `kind` (and any tips it needs)
 * to tailor the cause + fix. See {@link renderFailure}.
 */
export async function reportRunError(
  adapter: ForgeAdapter,
  plan: RunPlan,
  failure: Partial<Omit<FailureRender, 'mode'>> = {},
): Promise<void> {
  await adapter.updateTrackingComment(
    plan.tracking,
    renderFailure(plan.branding, { ...failure, mode: plan.mode, kind: failure.kind ?? 'error' }),
  );
}

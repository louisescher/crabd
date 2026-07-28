import type * as v from 'valibot';
import type { ResolvedConfig } from '@crabd/config';
import type { ForgeAdapter, ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { WorkspaceState } from '../git/workspace.ts';
import type { TriggerResult } from '../trigger/detect.ts';

/** Context handed to a mode's `finalize` step, after the model returns structured data. */
export interface FinalizeContext<T = unknown> {
  adapter: ForgeAdapter;
  config: ResolvedConfig;
  event: ForgeEvent;
  context: ForgeContext;
  trigger: TriggerResult;
  /** The validated structured output the model produced. */
  data: T;
  /** Working directory of the checked-out repo (the `local()` sandbox root). */
  cwd: string;
  /**
   * Resolved VCS state of that checkout. Modes that check the model's output against the files on
   * disk need it to know whether those files are the change under review at all.
   */
  workspace?: WorkspaceState;
}

export interface FinalizeResult {
  /** Full result text — used for the CI output, and the tracking comment by default. */
  summary: string;
  /** URL of a PR opened/updated by the mode, if any. */
  prUrl?: string;
  /**
   * Overrides the tracking-comment text when the mode already posted its detailed
   * output elsewhere (e.g. review mode posts a PR review), so the tracking comment
   * doesn't repeat it. Falls back to `summary` when unset.
   */
  trackingComment?: string;
}

/**
 * A mode turns an event into one agent run. It declares the Valibot output schema
 * the model must satisfy, the forge tools it wants exposed, and a `finalize` step
 * that performs the forge side effects (comment/review/commit/PR) from that output.
 */
/**
 * Outcome of a mode's semantic validation of the model's structured output.
 *
 * Distinct from schema validation, which the framework already enforces: this catches output that
 * is well-typed but wrong about the world — a finding anchored to a line the forge will reject, a
 * path that isn't in the diff, a verdict that contradicts the findings. Those used to be discovered
 * in `finalize`, long after the model was gone, so it made the same mistake on every run.
 */
export type ValidateResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * A follow-up prompt naming what is wrong and what a correct answer looks like. Issued on the
       * same session so the model keeps everything it read, then its new answer replaces the old.
       */
      repairPrompt: string;
    };

export interface ModeDefinition<T = unknown> {
  name: string;
  /**
   * One-line description of when this mode applies. Shown to the intent classifier that
   * routes an ambiguous mention (see prepareRun); custom modes should set it so they can be
   * chosen. Falls back to the name when unset.
   */
  description?: string;
  /** Valibot schema the model's structured output must match. */
  outputSchema: v.GenericSchema<T>;
  /** Forge tool names this mode may use (documented; enforced by config allowlist). */
  tools: string[];
  /**
   * Optional semantic check on the structured output, run before {@link finalize}. Returning
   * `{ ok: false, repairPrompt }` asks the model to correct itself on the same session (bounded by
   * the caller). Omit when a mode has nothing to check beyond its schema.
   */
  validate?(data: T, ctx: ValidateContext): ValidateResult;
  /** Perform forge side effects from the structured output. */
  finalize(ctx: FinalizeContext<T>): Promise<FinalizeResult>;
}

/**
 * What a mode needs to validate output, before any side effects.
 *
 * Deliberately narrow rather than the whole {@link FinalizeContext}: validation runs inside the
 * model-turn subprocess, which has neither the resolved config nor the fetched forge context. Every
 * field here is small enough to hand across that boundary as workflow input — the anchorable line
 * set in particular is passed as compact ranges rather than by re-sending the diff.
 */
export interface ValidateContext {
  /** Paths of the files this change touches. Empty when unknown (skips the path check). */
  changedPaths: string[];
  /** Lines a forge will accept an inline comment on, per file. Empty when there is no diff. */
  anchorable: Map<string, Set<number>>;
  /** Working directory of the checked-out repo. */
  cwd: string;
}

const registry = new Map<string, ModeDefinition<unknown>>();

/** Register (or replace) a mode. Enables custom modes without touching the core. */
export function registerMode<T>(definition: ModeDefinition<T>): void {
  registry.set(definition.name, definition as ModeDefinition<unknown>);
}

export function getMode(name: string): ModeDefinition<unknown> | undefined {
  return registry.get(name);
}

export function listModes(): string[] {
  return [...registry.keys()];
}

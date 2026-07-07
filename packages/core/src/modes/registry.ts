import type * as v from 'valibot';
import type { ResolvedConfig } from '@crabd/config';
import type { ForgeAdapter, ForgeContext, ForgeEvent } from '../forge/types.ts';
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
  /** Perform forge side effects from the structured output. */
  finalize(ctx: FinalizeContext<T>): Promise<FinalizeResult>;
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

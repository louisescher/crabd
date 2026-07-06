import type { ResolvedConfig, ThinkingLevel } from '@crabd/config';
import { assemblePrompt } from '../context/assemble.ts';
import { loadProjectContext } from '../context/project.ts';
import type { ForgeAdapter, ForgeContext, ForgeEvent, TrackingComment } from '../forge/types.ts';
import { getMode, listModes } from '../modes/registry.ts';
import { subjectNumber } from '../modes/shared.ts';
import { assertProvidersAllowed } from '../policy/providers.ts';
import { authorizeActor } from '../policy/trust.ts';
import { renderWorking } from '../report/tracking.ts';
import { detectTrigger, type TriggerResult } from '../trigger/detect.ts';

/** Everything the Flue phase needs to run one agent turn. */
export interface RunPlan {
  mode: string;
  model: string;
  thinkingLevel: ThinkingLevel;
  /** System instructions (base/override + layered appends). */
  instructions: string;
  /** User turn (rendered forge context + post-mention instruction). */
  message: string;
  /** Forge tools this mode may use. */
  toolNames: string[];
  /** The posted "working..." tracking comment, updated on completion. */
  tracking: TrackingComment;
  /** Issue/PR number the run concerns. */
  subject: number;
}

export type PrepareOutcome =
  | { status: 'run'; plan: RunPlan; context: ForgeContext; trigger: TriggerResult }
  | { status: 'skip'; reason: string }
  | { status: 'denied'; reason: string };

export interface PrepareInput {
  adapter: ForgeAdapter;
  config: ResolvedConfig;
  event: ForgeEvent;
  /** Repo checkout root, used to read project context (AGENTS.md/CLAUDE.md, skills). */
  cwd: string;
}

/**
 * Phase 1 (plain Node): detect the mode, gate on trust + provider allowlist, fetch
 * context, assemble the prompt, and post the initial tracking comment. Returns a
 * {@link RunPlan} to hand to the Flue phase, or a skip/denied outcome.
 */
export async function prepareRun(input: PrepareInput): Promise<PrepareOutcome> {
  const { adapter, config, event, cwd } = input;

  // Known modes are all registered ones (built-ins + custom from crabd.config.ts);
  // enabled modes are those minus any explicitly disabled in config. Passing both lets a
  // custom mode's name work as a trigger keyword while a disabled mode is gated out.
  const knownModes = new Set(listModes());
  const enabledModes = new Set([...knownModes].filter((name) => config.modes[name]?.enabled !== false));

  const trigger = detectTrigger(event, { triggerPhrase: config.triggerPhrase, enabledModes, knownModes });
  if (!trigger) return { status: 'skip', reason: 'no trigger matched this event' };

  const auth = authorizeActor(event.actor, config.permissions.allowedAssociations);
  if (!auth.allowed) return { status: 'denied', reason: auth.reason ?? 'actor not authorized' };

  // Fast acknowledgment: react 👀 to the triggering comment so the user sees crab'd
  // picked it up immediately, before the slower context fetch and model run.
  if (event.comment) {
    try {
      await adapter.reactToComment(event.comment.id, 'eyes');
    } catch {
      // Reactions are best-effort.
    }
  }

  // Defense in depth: fail loudly before any repo content reaches a provider.
  assertProvidersAllowed(config);

  const modeDef = getMode(trigger.mode);
  if (!modeDef) return { status: 'skip', reason: `no mode registered for "${trigger.mode}"` };

  const context = await adapter.getContext(event);
  const subject = subjectNumber(context, event);
  if (subject === undefined) return { status: 'skip', reason: 'no issue or pull request to act on' };

  const modeCfg = config.modes[trigger.mode];
  const model = modeCfg?.model ?? config.model;
  const thinkingLevel = modeCfg?.thinkingLevel ?? config.thinkingLevel;
  const toolNames = modeCfg?.tools ?? modeDef.tools;

  // Repo-authored context: the target repo's own AGENTS.md/CLAUDE.md and skill manifest,
  // gated by config. Read-only and best-effort — never blocks the run.
  const project = loadProjectContext(cwd, {
    instructionFiles: config.context.instructionFiles,
    skills: config.context.skills,
  });

  const prompt = assemblePrompt({ mode: trigger.mode, config, context, event, trigger, project });

  // Reuse an existing crab'd comment on this subject (sticky) instead of stacking new ones.
  let tracking = await adapter.findTrackingComment(subject);
  if (tracking) {
    await adapter.updateTrackingComment(tracking, renderWorking(trigger.mode));
  } else {
    tracking = await adapter.createTrackingComment(subject, renderWorking(trigger.mode));
  }

  return {
    status: 'run',
    plan: {
      mode: trigger.mode,
      model,
      thinkingLevel,
      instructions: prompt.instructions,
      message: prompt.message,
      toolNames,
      tracking,
      subject,
    },
    context,
    trigger,
  };
}

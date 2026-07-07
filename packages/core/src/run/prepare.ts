import type { ResolvedConfig, ThinkingLevel } from '@crabd/config';
import { assemblePrompt } from '../context/assemble.ts';
import { loadProjectContext } from '../context/project.ts';
import type { ForgeAdapter, ForgeContext, ForgeEvent, TrackingComment } from '../forge/types.ts';
import { getMode, listModes } from '../modes/registry.ts';
import { subjectNumber } from '../modes/shared.ts';
import { assertProvidersAllowed } from '../policy/providers.ts';
import { authorizeActor } from '../policy/trust.ts';
import { renderWorking, type Branding } from '../report/tracking.ts';
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
  /** Name/emoji/footer crab'd uses in comments for this run (from `config.appearance`). */
  branding: Branding;
}

export type PrepareOutcome =
  | { status: 'run'; plan: RunPlan; context: ForgeContext; trigger: TriggerResult }
  | { status: 'skip'; reason: string }
  | { status: 'denied'; reason: string };

/** A candidate mode the classifier may route a bare mention to. */
export interface ClassifyCandidate {
  name: string;
  /** When this mode applies (from the mode's `description`), to steer the classifier. */
  description: string;
}

/** What the classifier needs to route a bare mention to the mode the user actually meant. */
export interface ClassifyRequest {
  /** Enabled modes the mention could be routed to — includes `mention` itself (a plain answer). */
  candidates: ClassifyCandidate[];
  /** The full triggering comment body. */
  comment: string;
  /** Text the user wrote after the trigger phrase, if any. */
  instruction?: string;
  /** Whether the comment is on a pull request (so `review` is meaningful). */
  isPullRequest: boolean;
  /** Title of the issue/PR the comment is on, for light context. */
  subjectTitle?: string;
}

/**
 * Resolve a bare mention to a concrete mode. Injected by the caller — the action wires this to
 * a cheap, no-tools model pass (see the `crabd-classify` workflow). Returns the chosen mode
 * name, or `undefined` to keep the default (`mention`). Must fail soft: any error keeps mention.
 */
export type ClassifyFn = (request: ClassifyRequest) => Promise<{ mode: string } | undefined>;

export interface PrepareInput {
  adapter: ForgeAdapter;
  config: ResolvedConfig;
  event: ForgeEvent;
  /** Repo checkout root, used to read project context (AGENTS.md/CLAUDE.md, skills). */
  cwd: string;
  /**
   * Optional intent classifier for bare mentions. When set, a mention that carries no mode
   * keyword ("@crabd please review again") is routed to the mode the classifier picks — so a
   * re-review request runs the full review mode (inline findings + verdict) instead of a lone
   * comment. Best-effort: skipped for explicit keywords/events and on any classifier error.
   */
  classify?: ClassifyFn;
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

  let actor = event.actor;
  if (event.forge === 'forgejo' && !actor.isBot && actor.association.toUpperCase() === 'NONE') {
    try {
      actor = await adapter.resolveActor(actor.login);
    } catch {
      // keep the parsed actor (NONE) → denied
    }
  }

  const auth = authorizeActor(actor, config.permissions.allowedAssociations);
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

  // Smart routing: a bare mention ("please review again") carries no mode keyword, so it fell
  // back to `mention`. When a classifier is wired, ask it (cheaply) which enabled mode the user
  // actually wants and route there — so a re-review request runs the full review mode (inline
  // findings + verdict) instead of a single free-text comment. Best-effort: any failure or an
  // out-of-set answer keeps the default mention.
  let resolvedTrigger = trigger;
  if (input.classify && event.comment && !trigger.explicit) {
    const candidates = [...enabledModes].map((name) => ({
      name,
      description: getMode(name)?.description ?? name,
    }));
    // Only classify when there is a real choice beyond just answering (mention).
    if (candidates.length > 1) {
      const subjectTitle = event.pullRequest?.title ?? event.issue?.title;
      try {
        const decision = await input.classify({
          candidates,
          comment: event.comment.body,
          ...(trigger.userInstruction ? { instruction: trigger.userInstruction } : {}),
          isPullRequest: event.isPullRequest ?? event.kind === 'pull_request',
          ...(subjectTitle ? { subjectTitle } : {}),
        });
        if (decision && enabledModes.has(decision.mode)) {
          resolvedTrigger = { ...trigger, mode: decision.mode };
        }
      } catch {
        // Classification is best-effort — keep the default mention on any failure.
      }
    }
  }

  const modeDef = getMode(resolvedTrigger.mode);
  if (!modeDef) return { status: 'skip', reason: `no mode registered for "${resolvedTrigger.mode}"` };

  const context = await adapter.getContext(event);
  const subject = subjectNumber(context, event);
  if (subject === undefined) return { status: 'skip', reason: 'no issue or pull request to act on' };

  const modeCfg = config.modes[resolvedTrigger.mode];
  const model = modeCfg?.model ?? config.model;
  const thinkingLevel = modeCfg?.thinkingLevel ?? config.thinkingLevel;
  const toolNames = modeCfg?.tools ?? modeDef.tools;

  // Repo-authored context: the target repo's own AGENTS.md/CLAUDE.md and skill manifest,
  // gated by config. Read-only and best-effort — never blocks the run.
  const project = loadProjectContext(cwd, {
    instructionFiles: config.context.instructionFiles,
    skills: config.context.skills,
  });

  const prompt = assemblePrompt({
    mode: resolvedTrigger.mode,
    config,
    context,
    event,
    trigger: resolvedTrigger,
    project,
  });
  const branding = config.appearance;

  // Reuse an existing crab'd comment on this subject (sticky) instead of stacking new ones.
  let tracking = await adapter.findTrackingComment(subject);
  if (tracking) {
    await adapter.updateTrackingComment(tracking, renderWorking(branding, resolvedTrigger.mode));
  } else {
    tracking = await adapter.createTrackingComment(subject, renderWorking(branding, resolvedTrigger.mode));
  }

  return {
    status: 'run',
    plan: {
      mode: resolvedTrigger.mode,
      model,
      thinkingLevel,
      instructions: prompt.instructions,
      message: prompt.message,
      toolNames,
      tracking,
      subject,
      branding,
    },
    context,
    trigger: resolvedTrigger,
  };
}

import type { ResolvedConfig } from '@crabd/config';
import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import type { TriggerResult } from '../trigger/detect.ts';

/** Built-in base system prompt per built-in mode. Overridable via full prompt override. */
const BASE_PROMPTS: Record<string, string> = {
  mention: [
    "You are crab'd, an autonomous coding agent responding to a mention on a code forge.",
    'Answer the request directly. If code changes are warranted, make them and commit to a branch.',
    'Be concise and act; do not ask for confirmation you can reasonably infer.',
  ].join('\n'),
  review: [
    "You are crab'd, an autonomous code reviewer.",
    'Review the pull request diff for correctness, security, and clarity. Prefer a small number of high-signal findings over exhaustive nitpicking.',
    'Post a concise summary and, where useful, specific inline findings.',
    'Pick a verdict: APPROVE when it is good to merge (LGTM), COMMENT when only minor nits remain, REQUEST_CHANGES when findings should be addressed before merging.',
  ].join('\n'),
  implement: [
    "You are crab'd, an autonomous coding agent implementing an issue end-to-end.",
    'Understand the issue, plan the change, implement it, and open a pull request.',
    'Keep the change focused on the issue; match the surrounding code style.',
  ].join('\n'),
};

const GENERIC_BASE = "You are crab'd, an autonomous coding agent operating on a code forge.";

function baseInstructions(mode: string): string {
  return BASE_PROMPTS[mode] ?? GENERIC_BASE;
}

export interface AssembledPrompt {
  /** System-level instructions: who the agent is + rules (base or override, plus appends). */
  instructions: string;
  /** The user turn: rendered forge context and the triggering instruction. */
  message: string;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

/** Render the fetched forge context into a readable markdown block for the model. */
function renderContext(context: ForgeContext, event: ForgeEvent): string {
  const lines: string[] = [];
  lines.push(`## Repository\n${context.repo.slug} (default branch: ${context.repo.defaultBranch})`);

  const subject = context.pullRequest ?? context.issue;
  if (subject) {
    const kind = context.pullRequest ? 'Pull Request' : 'Issue';
    lines.push(`## ${kind} #${subject.number}: ${subject.title}\n${subject.body || '(no description)'}`);
  }
  if (context.pullRequest) {
    lines.push(`Head: \`${context.pullRequest.headRef}\` → Base: \`${context.pullRequest.baseRef}\``);
  }

  if (context.changedFiles.length > 0) {
    const files = context.changedFiles
      .map((f) => `- ${f.status} \`${f.path}\` (+${f.additions}/-${f.deletions})`)
      .join('\n');
    lines.push(`## Changed files (${context.changedFiles.length})\n${files}`);
  }

  if (context.diff) {
    lines.push(`## Diff\n\`\`\`diff\n${truncate(context.diff, 60_000)}\n\`\`\``);
  }

  if (context.comments.length > 0) {
    // Label crab'd's own prior replies so the model has conversational continuity.
    const recent = context.comments
      .slice(-10)
      .map((c) => {
        const isCrabd = c.body.includes(TRACKING_MARKER);
        const who = isCrabd ? "crab'd (you, earlier)" : c.author;
        const body = c.body.split(TRACKING_MARKER).join('').trim();
        return `**${who}:** ${body}`;
      })
      .join('\n\n');
    lines.push(`## Recent comments\n${recent}`);
  }

  if (event.comment) {
    lines.push(`## Triggering comment (by ${event.comment.author})\n${event.comment.body}`);
  }

  return lines.join('\n\n');
}

export interface AssembleOptions {
  mode: string;
  config: ResolvedConfig;
  context: ForgeContext;
  event: ForgeEvent;
  trigger: TriggerResult;
}

/**
 * Build the agent's `instructions` and user `message` for a run.
 *
 * `instructions` = (full override, if permitted, else the built-in base for the mode)
 *   + global `prompt.instructions` + per-mode `instructions`.
 * `message` = rendered forge context + the post-mention `userInstruction` (threaded
 *   into every mode, so a mention can steer a review or implementation).
 */
export function assemblePrompt(options: AssembleOptions): AssembledPrompt {
  const { mode, config, context, event, trigger } = options;

  const base = config.prompt.override ?? baseInstructions(mode);
  const appends = [config.prompt.instructions, config.modes[mode]?.instructions].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  const instructions = [base, ...appends].join('\n\n');

  const parts = [renderContext(context, event)];
  if (trigger.userInstruction) {
    parts.push(`## Instruction from the user\n${trigger.userInstruction}`);
  }

  return { instructions, message: parts.join('\n\n') };
}

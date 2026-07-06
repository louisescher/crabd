import type { ResolvedConfig } from '@crabd/config';
import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { ProjectContext } from './project.ts';
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

/**
 * The default operating-environment note appended to every built-in base prompt. It keeps the
 * agent from burning its turn budget chasing things it can't reach — the most common cause of
 * a run hitting the tool-call ceiling is looping on a cross-repo file or CI system it has no
 * access to. (Skipped when the prompt is fully overridden — that caller owns the whole base.)
 */
const SEALED_ENVIRONMENT_NOTE = [
  'Operating environment: you are working in a single checked-out repository.',
  'Your file and command tools only see this checkout, and your credentials are generally scoped to this repository — you cannot browse other repositories, private APIs, or the CI/build system.',
  'If something you need is outside this checkout, note the limitation and continue with what you have rather than spending steps retrying access you do not have.',
].join(' ');

/**
 * The operating-environment note, made aware of any configured cross-repo READ access
 * (`repos.read`) and the forge. Sealed/single-repo by default; when access is granted, it tells the
 * agent which repos it may read and how (`GH_TOKEN` + preconfigured `git`; `gh` on GitHub only).
 */
function environmentNote(repos: ResolvedConfig['repos'] | undefined, forge: string): string {
  const read = repos?.read;
  if (!read || (Array.isArray(read) && read.length === 0)) return SEALED_ENVIRONMENT_NOTE;
  const scope =
    read === 'all' ? 'any repository your token can access' : `these repositories: ${read.join(', ')}`;
  // `gh` is GitHub-only; on Forgejo the agent uses git or the Forgejo API.
  const how =
    forge === 'forgejo'
      ? '`git clone --depth 1 https://HOST/OWNER/REPO` or the Forgejo API (`/api/v1`)'
      : '`gh api` for a single file (e.g. `gh api repos/OWNER/REPO/contents/PATH`) or `git clone --depth 1 https://HOST/OWNER/REPO`';
  return [
    `Operating environment: you are working in the checkout of the trigger repository, and you also have READ access to ${scope}.`,
    `A token for reading them is in your shell as \`GH_TOKEN\` and \`git\` is preconfigured to use it — read those repositories with ${how}. You may NOT write to them — your committed changes only ever land in the trigger repository.`,
    'If you need access beyond this, note the limitation and continue rather than spending steps retrying access you do not have.',
  ].join(' ');
}

function baseInstructions(mode: string, repos: ResolvedConfig['repos'] | undefined, forge: string): string {
  return `${BASE_PROMPTS[mode] ?? GENERIC_BASE}\n${environmentNote(repos, forge)}`;
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
  /** Repo-authored context (AGENTS.md/CLAUDE.md, skills) to fold into the system prompt. */
  project?: ProjectContext;
}

/**
 * Render the repo-authored context into system-prompt sections: the project's own
 * instruction files, then a manifest of available skills the agent can read on demand.
 * Returns the blocks to append after crab'd's base + config instructions — so crab'd's
 * own rules stay above repo-controlled text.
 */
function renderProjectContext(project: ProjectContext | undefined): string[] {
  if (!project) return [];
  const blocks: string[] = [];

  if (project.instructions) {
    blocks.push(
      [
        "## Project instructions (from the repository's AGENTS.md / CLAUDE.md)",
        'Follow these as you would any project convention. If they conflict with your core instructions above, your core instructions win.',
        '',
        project.instructions,
      ].join('\n'),
    );
  }

  if (project.skills.length > 0) {
    const list = project.skills.map((s) => `- **${s.name}** — ${s.description} (\`${s.path}\`)`).join('\n');
    blocks.push(
      [
        '## Available skills',
        'This repository provides task-specific skills. When your current task matches one, read its `SKILL.md` with your file tools for the full instructions before proceeding. Do not use a skill whose description does not match the task.',
        '',
        list,
      ].join('\n'),
    );
  }

  return blocks;
}

/**
 * Build the agent's `instructions` and user `message` for a run.
 *
 * `instructions` = (full override, if permitted, else the built-in base for the mode)
 *   + global `prompt.instructions` + per-mode `instructions`
 *   + repo-authored project context (AGENTS.md/CLAUDE.md + skill manifest), appended last.
 * `message` = rendered forge context + the post-mention `userInstruction` (threaded
 *   into every mode, so a mention can steer a review or implementation).
 */
export function assemblePrompt(options: AssembleOptions): AssembledPrompt {
  const { mode, config, context, event, trigger, project } = options;

  const base = config.prompt.override ?? baseInstructions(mode, config.repos, event.forge);
  const appends = [config.prompt.instructions, config.modes[mode]?.instructions].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  const instructions = [base, ...appends, ...renderProjectContext(project)].join('\n\n');

  const parts = [renderContext(context, event)];
  if (trigger.userInstruction) {
    parts.push(`## Instruction from the user\n${trigger.userInstruction}`);
  }

  return { instructions, message: parts.join('\n\n') };
}

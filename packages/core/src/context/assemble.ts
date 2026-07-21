import type { ResolvedConfig } from '@crabd/config';
import type { ForgeChangedFile, ForgeContext, ForgeEvent } from '../forge/types.ts';
import type { ProjectContext } from './project.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';
import type { TriggerResult } from '../trigger/detect.ts';

/** Built-in base system prompt per non-review built-in mode. Overridable via full prompt override. */
const BASE_PROMPTS: Record<string, string> = {
  mention: [
    "You are crab'd, an autonomous coding agent responding to a mention on a code forge.",
    'Answer the request directly. If code changes are warranted, make them and commit to a branch.',
    'Be concise and act; do not ask for confirmation you can reasonably infer.',
  ].join('\n'),
  implement: [
    "You are crab'd, an autonomous coding agent implementing an issue end-to-end.",
    'Understand the issue, plan the change, implement it, and open a pull request.',
    'Keep the change focused on the issue; match the surrounding code style.',
  ].join('\n'),
};

/**
 * The review guidance line, keyed by strictness (`review.strictness`, 1–5). It replaces a single
 * fixed line: `1` flags only merge-blockers, `2` (default) is high-signal-over-nitpicking, and
 * `3`–`5` progressively lower the bar for a finding, push crab'd to keep looking rather than
 * conclude "no issues," and make it more reluctant to hand out a clean APPROVE.
 */
const REVIEW_STRICTNESS_GUIDANCE: Record<number, string> = {
  1: 'Flag only issues that would break correctness or security, or otherwise block a merge. Ignore style, naming, and other minor concerns, and approve readily when nothing is broken.',
  2: 'Prefer a small number of high-signal findings over exhaustive nitpicking, focusing on correctness, security, and clarity.',
  3: 'Report minor issues too — edge cases, error handling, missing tests, and unclear naming — not just high-signal ones. Do not approve simply because nothing major stands out.',
  4: 'Review strictly: actively hunt for problems across correctness, security, clarity, naming, test coverage, and docs. Keep digging rather than concluding early that there is nothing to flag, and be reluctant to APPROVE while addressable findings remain.',
  5: 'Review pedantically: flag anything that could be improved, including style, naming, formatting, and micro-level concerns. Treat "no issues found" as a last resort — assume there is something worth raising and look until you find it. Reserve APPROVE for changes with genuinely nothing to note.',
};
const DEFAULT_REVIEW_STRICTNESS = 2;

/** Build the review base prompt, with the middle guidance line set by the strictness level. */
function reviewPrompt(strictness: number): string {
  const guidance = REVIEW_STRICTNESS_GUIDANCE[strictness] ?? REVIEW_STRICTNESS_GUIDANCE[DEFAULT_REVIEW_STRICTNESS];
  return [
    "You are crab'd, an autonomous code reviewer.",
    `Review the pull request diff for correctness, security, and clarity. ${guidance}`,
    'Post a concise summary and, where useful, specific inline findings.',
    'Pick a verdict: APPROVE when it is good to merge (LGTM), COMMENT when only minor nits remain, REQUEST_CHANGES when findings should be addressed before merging.',
  ].join('\n');
}

const GENERIC_BASE = "You are crab'd, an autonomous coding agent operating on a code forge.";

/**
 * Voice guidance appended to every built-in base prompt: crab'd's user-facing text (review
 * summaries, comment replies, PR descriptions) should read plainly and match a direct, technical
 * style rather than glazing. (Skipped when the prompt is fully overridden — that caller owns the
 * whole base.)
 */
const VOICE_NOTE = [
  'Voice: write plainly and directly, in a technical, no-frills style.',
  'State what you found and why it matters — do not open with praise or congratulations, and skip filler like "Great work!" or "This looks solid."',
  'Do not soften or pad your points to seem agreeable. If something is fine, say so briefly, without flattery.',
].join(' ');

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

function baseInstructions(mode: string, config: ResolvedConfig, forge: string): string {
  const base = mode === 'review' ? reviewPrompt(config.review.strictness) : (BASE_PROMPTS[mode] ?? GENERIC_BASE);
  return `${base}\n${VOICE_NOTE}\n${environmentNote(config.repos, forge)}`;
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

/** Char budget for the full (untoggled) diff — the historical hard clip. */
const FULL_DIFF_BUDGET = 60_000;
/** Global char budget for the compressed diff body. */
const COMPRESSED_DIFF_BUDGET = 24_000;
/** Per-file char cap in the compressed diff; larger files are clipped to the whole hunks that fit. */
const PER_FILE_DIFF_BUDGET = 6_000;

// Char budgets for the free-text bodies in the context message. Each is re-sent on every turn of the
// agentic loop (and re-paid uncached on providers without prompt caching), so a pasted log or a huge
// PR description shouldn't ride along 40×. Budgets sit well above normal prose; these bodies aren't
// recoverable via the agent's file tools, so truncation is generous and clearly noted.
/** Char budget for the PR/issue description. */
const SUBJECT_BODY_BUDGET = 6_000;
/** Char budget for the comment that triggered the run (usually the user's ask). */
const TRIGGER_COMMENT_BUDGET = 4_000;
/** Per-comment char budget within the recent-comments list. */
const COMMENT_BODY_BUDGET = 2_000;

/**
 * Low-signal files whose diff bodies are dropped from the compressed diff: lockfiles and
 * generated/vendored/minified output. They're huge and near-useless to read line-by-line; the
 * agent still sees them in the "Changed files" list and can open any of them with its tools.
 */
const LOW_SIGNAL_RULES: { reason: string; test: (path: string) => boolean }[] = [
  {
    reason: 'lockfile',
    test: (p) =>
      /(^|\/)(pnpm-lock\.yaml|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|composer\.lock|Gemfile\.lock|poetry\.lock|Cargo\.lock|go\.sum|flake\.lock)$/.test(
        p,
      ) || /\.lock$/.test(p),
  },
  {
    reason: 'generated',
    test: (p) =>
      /(^|\/)(dist|build|out|vendor|node_modules|__snapshots__)\//.test(p) || /\.(min\.(js|css)|map|snap)$/.test(p),
  },
];

function lowSignalReason(path: string): string | undefined {
  return LOW_SIGNAL_RULES.find((rule) => rule.test(path))?.reason;
}

function fence(body: string): string {
  return `\`\`\`diff\n${body}\n\`\`\``;
}

/** Extract the target path from one `diff --git` section (prefers the new path). */
function sectionPath(section: string): string | undefined {
  const plus = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  if (plus && plus !== '/dev/null') return plus.trim();
  const minus = section.match(/^--- a\/(.+)$/m)?.[1];
  if (minus && minus !== '/dev/null') return minus.trim();
  return section.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2]?.trim();
}

/** Split a whole unified diff into per-file sections, each starting at its `diff --git` line. */
export function splitSections(diff: string): { path: string; text: string }[] {
  const start = diff.indexOf('diff --git ');
  if (start === -1) return [];
  return diff
    .slice(start)
    .split(/\n(?=diff --git )/)
    .flatMap((text) => {
      const path = sectionPath(text);
      return path ? [{ path, text }] : [];
    });
}

/** Keep the whole `@@` hunks of a section that fit under `cap`; report how many of how many. */
function clipSection(text: string, cap: number): { text: string; shown: number; total: number } {
  const firstHunk = text.indexOf('\n@@');
  if (firstHunk === -1) return { text: truncate(text, cap), shown: 0, total: 0 };
  const header = text.slice(0, firstHunk);
  const hunks = text.slice(firstHunk + 1).split(/\n(?=@@ )/);
  const kept: string[] = [];
  let size = header.length;
  for (const hunk of hunks) {
    if (kept.length > 0 && size + hunk.length + 1 > cap) break;
    kept.push(hunk);
    size += hunk.length + 1;
  }
  return { text: `${header}\n${kept.join('\n')}`, shown: kept.length, total: hunks.length };
}

/**
 * Compress a whole-PR unified diff into a high-signal, budgeted block: drop lockfiles and
 * generated output, clip oversized files to the hunks that fit, and stop once the global budget is
 * spent — then list what was dropped or clipped so the agent knows to read those files if it needs
 * them. Returns the markdown that follows the `## Diff` heading (fenced diff + optional note). If
 * the input doesn't parse as `diff --git` sections, falls back to a plain budgeted truncation.
 */
export function compressDiff(diff: string, changedFiles: ForgeChangedFile[]): string {
  const sections = splitSections(diff);
  if (sections.length === 0) return fence(truncate(diff, COMPRESSED_DIFF_BUDGET));

  const byPath = new Map(changedFiles.map((f) => [f.path, f]));
  const included: string[] = [];
  const notes: { path: string; reason: string }[] = [];
  let used = 0;

  for (const { path, text } of sections) {
    const low = lowSignalReason(path);
    if (low) {
      notes.push({ path, reason: low });
      continue;
    }
    const remaining = COMPRESSED_DIFF_BUDGET - used;
    const cap = Math.min(PER_FILE_DIFF_BUDGET, remaining);
    if (remaining <= 0) {
      notes.push({ path, reason: 'not shown (diff budget)' });
      continue;
    }
    if (text.length <= cap) {
      included.push(text);
      used += text.length + 1;
      continue;
    }
    const clip = clipSection(text, cap);
    if (clip.shown === 0) {
      notes.push({ path, reason: 'not shown (diff budget)' });
      continue;
    }
    included.push(clip.text);
    used += clip.text.length + 1;
    if (clip.shown < clip.total) notes.push({ path, reason: `${clip.shown} of ${clip.total} hunks shown` });
  }

  const body = fence(included.join('\n'));
  if (notes.length === 0) return body;

  const list = notes
    .map(({ path, reason }) => {
      const f = byPath.get(path);
      return f ? `\`${path}\` (${reason}, +${f.additions}/-${f.deletions})` : `\`${path}\` (${reason})`;
    })
    .join(', ');
  return `${body}\n\n_Some files above are compressed or omitted to save space — every change is in the "Changed files" list; read a file directly if you need its full diff: ${list}._`;
}

/**
 * Render the fetched forge context into a readable markdown block for the model. `fullDiff` (from
 * `context.full_diff`, off by default) sends the whole diff; otherwise the diff is compressed.
 */
function renderContext(context: ForgeContext, event: ForgeEvent, fullDiff: boolean): string {
  const lines: string[] = [];
  lines.push(`## Repository\n${context.repo.slug} (default branch: ${context.repo.defaultBranch})`);

  const subject = context.pullRequest ?? context.issue;
  if (subject) {
    const kind = context.pullRequest ? 'Pull Request' : 'Issue';
    const body = subject.body ? truncate(subject.body, SUBJECT_BODY_BUDGET) : '(no description)';
    lines.push(`## ${kind} #${subject.number}: ${subject.title}\n${body}`);
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
    const rendered = fullDiff ? fence(truncate(context.diff, FULL_DIFF_BUDGET)) : compressDiff(context.diff, context.changedFiles);
    lines.push(`## Diff\n${rendered}`);
  }

  // The triggering comment is rendered in full under its own header below; drop it here so it isn't
  // sent twice when it's also present in the fetched comment list.
  const triggerId = event.comment?.id;
  const recentComments = context.comments.slice(-10).filter((c) => c.id !== triggerId);
  if (recentComments.length > 0) {
    // Label crab'd's own prior replies so the model has conversational continuity.
    const recent = recentComments
      .map((c) => {
        const isCrabd = c.body.includes(TRACKING_MARKER);
        const who = isCrabd ? "crab'd (you, earlier)" : c.author;
        const body = truncate(c.body.split(TRACKING_MARKER).join('').trim(), COMMENT_BODY_BUDGET);
        return `**${who}:** ${body}`;
      })
      .join('\n\n');
    lines.push(`## Recent comments\n${recent}`);
  }

  if (event.comment) {
    lines.push(`## Triggering comment (by ${event.comment.author})\n${truncate(event.comment.body, TRIGGER_COMMENT_BUDGET)}`);
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

  const base = config.prompt.override ?? baseInstructions(mode, config, event.forge);
  const appends = [config.prompt.instructions, config.modes[mode]?.instructions].filter(
    (s): s is string => Boolean(s && s.trim()),
  );
  const instructions = [base, ...appends, ...renderProjectContext(project)].join('\n\n');

  const parts = [renderContext(context, event, config.context.fullDiff)];
  if (trigger.userInstruction) {
    parts.push(`## Instruction from the user\n${trigger.userInstruction}`);
  }

  return { instructions, message: parts.join('\n\n') };
}

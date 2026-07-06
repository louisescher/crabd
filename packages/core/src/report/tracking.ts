/** Hidden marker identifying a crab'd tracking comment, for sticky reuse across runs. */
export const TRACKING_MARKER = '<!-- crabd:tracking -->';

/** Base URL of the crab'd documentation site, for the actionable links in failure comments. */
const DOCS_BASE = 'https://crabd.lou.gg';

/** How crab'd presents itself in a tracking comment: the display name, brand emoji, footer. */
export interface Branding {
  /** Display name used in comments (e.g. `crab'd`). */
  name: string;
  /** Brand emoji prefixed to comments; empty string renders no emoji. */
  emoji: string;
  /** Whether the visible `posted by <name>` footer is shown (the hidden marker is always kept). */
  footer: boolean;
}

/** The built-in branding — crab'd's own name, emoji, and footer. */
export const DEFAULT_BRANDING: Branding = { name: "crab'd", emoji: '🦀', footer: true };

/** The emoji prefix (`🦀 `) for a comment lead, or `''` when no emoji is configured. */
function prefix(b: Branding): string {
  return b.emoji ? `${b.emoji} ` : '';
}

/**
 * The comment footer. Always ends with {@link TRACKING_MARKER} so crab'd can find and reuse
 * its own comment across runs; the visible `posted by` line (with the attribution link) is
 * omitted when `branding.footer` is false.
 */
function footer(b: Branding): string {
  if (!b.footer) return `\n${TRACKING_MARKER}`;
  return `\n\n<sub>${prefix(b)}posted by [${b.name}](https://github.com/louisescher/crabd)</sub>\n${TRACKING_MARKER}`;
}

const MODE_VERB: Record<string, string> = {
  mention: 'working on your request',
  review: 'reviewing this pull request',
  implement: 'implementing this issue',
};

/** The initial "in progress" tracking comment body. */
export function renderWorking(branding: Branding, mode: string, runUrl?: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  const link = runUrl ? ` ([logs](${runUrl}))` : '';
  return `${prefix(branding)}**${branding.name}** is ${verb}...${link}${footer(branding)}`;
}

/** A live progress update posted mid-run by the agent's progress tool. */
export function renderProgress(branding: Branding, mode: string, message: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  return `${prefix(branding)}**${branding.name}** is ${verb}...\n\n${message.trim()}${footer(branding)}`;
}

export interface RateLimitedRender {
  mode: string;
  /** Provider that rate-limited us, if known (e.g. `anthropic`). */
  provider?: string;
  /** The model crab'd is about to (re)try. */
  nextModel?: string;
  /** 1-based number of the attempt crab'd is about to make. */
  attempt?: number;
  /** Seconds crab'd will wait before that attempt. */
  waitSeconds?: number;
  /** True when moving to a different (fallback) model rather than retrying the primary. */
  switching?: boolean;
}

/**
 * A live tracking-comment update while crab'd is waiting out / retrying a rate
 * limit or switching to a fallback model.
 */
export function renderRateLimited(branding: Branding, render: RateLimitedRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const provider = render.provider ? ` on \`${render.provider}\`` : '';
  const wait = render.waitSeconds && render.waitSeconds > 0 ? ` waiting ~${Math.round(render.waitSeconds)}s, then` : '';
  const target =
    render.switching && render.nextModel
      ? ` switching to fallback model \`${render.nextModel}\``
      : render.nextModel
        ? ` retrying with \`${render.nextModel}\``
        : ' retrying';
  const attempt = render.attempt ? ` (attempt ${render.attempt})` : '';
  return `${prefix(branding)}**${branding.name}** hit a rate limit${provider} while ${verb} —${wait}${target}${attempt}…${footer(branding)}`;
}

export interface RateLimitExhaustedRender {
  mode: string;
  /** Number of model attempts crab'd made before giving up. */
  attempts: number;
  /** The last model tried, if known. */
  lastModel?: string;
  /** True = crab'd finished the run green (soft); false = it failed the check. */
  soft: boolean;
  /** Trigger phrase to suggest for a manual retry (e.g. `/crabd`). */
  triggerPhrase?: string;
}

/** The tracking comment when every model in the chain was rate-limited / the wait budget ran out. */
export function renderRateLimitExhausted(branding: Branding, render: RateLimitExhaustedRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const last = render.lastModel ? ` (last tried \`${render.lastModel}\`)` : '';
  const plural = render.attempts === 1 ? '' : 's';
  const modeKeyword = render.mode === 'mention' ? '' : ` ${render.mode}`;
  const retry = render.triggerPhrase
    ? ` Comment \`${render.triggerPhrase}${modeKeyword}\` to try again once the limits ease.`
    : ' Try again once the rate limits ease.';
  // Status glyphs (⏳/⚠️) mark the outcome and are intentionally not part of brand emoji.
  const lead = render.soft
    ? `⏳ **${branding.name}** couldn't finish ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`
    : `⚠️ **${branding.name}** failed while ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`;
  return `${lead}${retry}${footer(branding)}`;
}

export interface ResultRender {
  mode: string;
  summary: string;
  prUrl?: string;
  runUrl?: string;
  /** Optional disclosure line appended as a <sub> note (e.g. a fallback model was used). */
  note?: string;
}

/** The final tracking comment body once the run succeeds. */
export function renderResult(branding: Branding, render: ResultRender): string {
  const parts = [render.summary.trim()];
  if (render.prUrl) parts.push(`\n➡️ Opened pull request: ${render.prUrl}`);
  if (render.note) parts.push(`\n<sub>${render.note}</sub>`);
  if (render.runUrl) parts.push(`\n<sub>[run logs](${render.runUrl})</sub>`);
  return parts.join('\n') + footer(branding);
}

/** The classes of terminal failure crab'd can post a tailored, actionable comment for. */
export type FailureKind = 'max_turns' | 'timeout' | 'config' | 'network' | 'error';

export interface FailureRender {
  mode: string;
  /** What went wrong, so the comment can tailor the cause + fix. Falls back to a generic error. */
  kind: FailureKind;
  /** The underlying error message, shown truncated in a collapsible block. Never a command dump. */
  detail?: string;
  /** Configured tool-call ceiling (`limits.max_turns`), for the max_turns tip. */
  maxTurns?: number;
  /** Configured wall-clock limit in minutes (`limits.timeout_minutes`), for the timeout tip. */
  timeoutMinutes?: number;
  /** Trigger phrase to suggest for a manual retry (e.g. `/crabd`). */
  triggerPhrase?: string;
  /** Link to the run logs, appended as a footer note. */
  runUrl?: string;
}

/** Render the underlying error as a collapsed, length-capped detail block (empty when none). */
function detailBlock(detail: string | undefined): string {
  const clean = detail?.trim();
  if (!clean) return '';
  const shown = clean.length > 600 ? `${clean.slice(0, 600)}\n… [truncated]` : clean;
  return `\n\n<details><summary>Error details</summary>\n\n\`\`\`\n${shown}\n\`\`\`\n\n</details>`;
}

/**
 * The tracking comment when a run fails. Unlike a raw stack trace, this explains what
 * happened, what to change (pointing at the specific config knob), and links the docs —
 * tailored per {@link FailureKind}. This is the single renderer behind every error crab'd posts.
 */
export function renderFailure(branding: Branding, render: FailureRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const name = branding.name;

  let lead: string;
  let tip: string;
  let docs: string;
  switch (render.kind) {
    case 'max_turns': {
      const limit = render.maxTurns ? ` (${render.maxTurns} turns)` : '';
      lead = `⚠️ **${name}** stopped while ${verb} — it reached the tool-call limit${limit} before finishing.`;
      tip = `This usually means the task was too broad for one run, or ${name} spent turns on things it couldn't complete (for example files or repositories it has no access to). **What to change:** narrow the request — point at specific files or split a large PR — or raise \`limits.max_turns\` if the task genuinely needs more steps.`;
      docs = `[Troubleshooting → run hit the turn limit](${DOCS_BASE}/troubleshooting/#run-hit-the-turn-limit)`;
      break;
    }
    case 'timeout': {
      const limit = render.timeoutMinutes ? ` ${render.timeoutMinutes}-minute` : '';
      lead = `⚠️ **${name}** ran out of time while ${verb} — the run exceeded its${limit} time limit.`;
      tip = `**What to change:** raise \`limits.timeout_minutes\`, or narrow the request so it finishes within the limit.`;
      docs = `[Troubleshooting → run timed out](${DOCS_BASE}/troubleshooting/#run-timed-out)`;
      break;
    }
    case 'config': {
      lead = `⚠️ **${name}** couldn't start ${verb} — its configuration is invalid.`;
      tip = `**What to change:** check your \`.crabd.yml\` / \`crabd.config.ts\` against the reference and fix the reported field.`;
      docs = `[Configuration](${DOCS_BASE}/configuration/)`;
      break;
    }
    case 'network': {
      lead = `⚠️ **${name}** hit a network or provider error while ${verb}.`;
      tip = `This is usually transient. **What to change:** try again in a moment; if it keeps happening, check your provider / gateway settings and keys.`;
      docs = `[Troubleshooting](${DOCS_BASE}/troubleshooting/)`;
      break;
    }
    default: {
      lead = `⚠️ **${name}** hit an error while ${verb}.`;
      tip = `**What to change:** check the details below and your configuration. If this looks like a bug in ${name}, please report it.`;
      docs = `[Troubleshooting](${DOCS_BASE}/troubleshooting/)`;
    }
  }

  const retry = render.triggerPhrase
    ? `Once you've adjusted things, comment \`${render.triggerPhrase}\` to try again.`
    : undefined;
  const runLog = render.runUrl ? `\n<sub>[run logs](${render.runUrl})</sub>` : '';
  const parts = [lead, tip, ...(retry ? [retry] : []), `📖 ${docs}`];
  return parts.join('\n\n') + detailBlock(render.detail) + runLog + footer(branding);
}

/** The tracking comment body when the run fails. Thin wrapper over {@link renderFailure}. */
export function renderError(branding: Branding, mode: string, message: string): string {
  return renderFailure(branding, { mode, kind: 'error', detail: message });
}

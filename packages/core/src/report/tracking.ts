/** Hidden marker identifying a crab'd tracking comment, for sticky reuse across runs. */
export const TRACKING_MARKER = '<!-- crabd:tracking -->';

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

/** The tracking comment body when the run fails. */
export function renderError(branding: Branding, mode: string, message: string): string {
  return `⚠️ **${branding.name}** hit an error while ${MODE_VERB[mode] ?? 'working'}:\n\n\`\`\`\n${message}\n\`\`\`${footer(branding)}`;
}

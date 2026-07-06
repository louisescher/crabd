/** Hidden marker identifying a crab'd tracking comment, for sticky reuse across runs. */
export const TRACKING_MARKER = '<!-- crabd:tracking -->';

const FOOTER = `\n\n<sub>🦀 posted by [crab'd](https://github.com/louisescher/crabd)</sub>\n${TRACKING_MARKER}`;

const MODE_VERB: Record<string, string> = {
  mention: 'working on your request',
  review: 'reviewing this pull request',
  implement: 'implementing this issue',
};

/** The initial "in progress" tracking comment body. */
export function renderWorking(mode: string, runUrl?: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  const link = runUrl ? ` ([logs](${runUrl}))` : '';
  return `🦀 **crab'd** is ${verb}...${link}${FOOTER}`;
}

/** A live progress update posted mid-run by the agent's progress tool. */
export function renderProgress(mode: string, message: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  return `🦀 **crab'd** is ${verb}...\n\n${message.trim()}${FOOTER}`;
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
export function renderRateLimited(render: RateLimitedRender): string {
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
  return `🦀 **crab'd** hit a rate limit${provider} while ${verb} —${wait}${target}${attempt}…${FOOTER}`;
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
export function renderRateLimitExhausted(render: RateLimitExhaustedRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const last = render.lastModel ? ` (last tried \`${render.lastModel}\`)` : '';
  const plural = render.attempts === 1 ? '' : 's';
  const modeKeyword = render.mode === 'mention' ? '' : ` ${render.mode}`;
  const retry = render.triggerPhrase
    ? ` Comment \`${render.triggerPhrase}${modeKeyword}\` to try again once the limits ease.`
    : ' Try again once the rate limits ease.';
  const lead = render.soft
    ? `⏳ **crab'd** couldn't finish ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`
    : `⚠️ **crab'd** failed while ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`;
  return `${lead}${retry}${FOOTER}`;
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
export function renderResult(render: ResultRender): string {
  const parts = [render.summary.trim()];
  if (render.prUrl) parts.push(`\n➡️ Opened pull request: ${render.prUrl}`);
  if (render.note) parts.push(`\n<sub>${render.note}</sub>`);
  if (render.runUrl) parts.push(`\n<sub>[run logs](${render.runUrl})</sub>`);
  return parts.join('\n') + FOOTER;
}

/** The tracking comment body when the run fails. */
export function renderError(mode: string, message: string): string {
  return `⚠️ **crab'd** hit an error while ${MODE_VERB[mode] ?? 'working'}:\n\n\`\`\`\n${message}\n\`\`\`${FOOTER}`;
}

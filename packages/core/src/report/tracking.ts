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

export interface ResultRender {
  mode: string;
  summary: string;
  prUrl?: string;
  runUrl?: string;
}

/** The final tracking comment body once the run succeeds. */
export function renderResult(render: ResultRender): string {
  const parts = [render.summary.trim()];
  if (render.prUrl) parts.push(`\n➡️ Opened pull request: ${render.prUrl}`);
  if (render.runUrl) parts.push(`\n<sub>[run logs](${render.runUrl})</sub>`);
  return parts.join('\n') + FOOTER;
}

/** The tracking comment body when the run fails. */
export function renderError(mode: string, message: string): string {
  return `⚠️ **crab'd** hit an error while ${MODE_VERB[mode] ?? 'working'}:\n\n\`\`\`\n${message}\n\`\`\`${FOOTER}`;
}

function isVerbose(): boolean {
  return process.env.CRABD_VERBOSE === 'true' || process.env.CRABD_DEBUG === 'true';
}

export function log(message: string): void {
  process.stderr.write(`[crabd] ${message}\n`);
}

export function warn(message: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning::[crabd] ${message}\n`);
  process.stderr.write(`[crabd] ${message}\n`);
}

export function debug(message: string | (() => string)): void {
  if (!isVerbose()) return;
  const text = typeof message === 'function' ? message() : message;
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::debug::[crabd] ${text}\n`);
  process.stderr.write(`[crabd] ${text}\n`);
}

/**
 * A collapsed section in the Actions log. Used for the model's reasoning, which is worth having and
 * too long to sit inline. Outside Actions the lines are written plainly, so local runs read the same.
 */
export function group(title: string, body: string): void {
  const text = body.trimEnd();
  if (!text) return;
  if (process.env.GITHUB_ACTIONS === 'true') {
    process.stdout.write(`::group::[crabd] ${title}\n${text}\n::endgroup::\n`);
    return;
  }
  process.stderr.write(`[crabd] ${title}\n${text}\n`);
}

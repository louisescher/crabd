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

function isVerbose(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CRABD_VERBOSE === 'true' || env.CRABD_DEBUG === 'true';
}

export function log(message: string): void {
  process.stderr.write(`[crabd] ${message}\n`);
}

export function warn(message: string, env: NodeJS.ProcessEnv = process.env): void {
  if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning::[crabd] ${message}\n`);
  process.stderr.write(`[crabd] ${message}\n`);
}

export function debug(message: string | (() => string), env: NodeJS.ProcessEnv = process.env): void {
  if (!isVerbose(env)) return;
  const text = typeof message === 'function' ? message() : message;
  if (env.GITHUB_ACTIONS === 'true') process.stdout.write(`::debug::[crabd] ${text}\n`);
  process.stderr.write(`[crabd] ${text}\n`);
}

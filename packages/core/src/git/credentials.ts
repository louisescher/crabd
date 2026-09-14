import { execFileSync } from 'node:child_process';
import { debug, log } from '../logger.ts';

/**
 * Remove the forge credentials `actions/checkout` leaves in the checkout's local git config, so
 * the model's shell in the workspace cannot push directly with them instead of going through
 * crab'd's own commit path. Best-effort: never throws, and returns the config keys removed.
 */
export function stripCheckoutCredentials(cwd: string): string[] {
  const removed: string[] = [];
  for (const key of credentialKeys(cwd)) {
    if (unset(cwd, key)) removed.push(key);
  }
  if (removed.length > 0) {
    log(`removed ${removed.length} checkout credential entr${removed.length === 1 ? 'y' : 'ies'} from the local git config`);
    debug(() => `stripCheckoutCredentials: ${removed.join(', ')}`);
  } else {
    debug(() => 'stripCheckoutCredentials: no checkout credentials in the local git config');
  }
  return removed;
}

function credentialKeys(cwd: string): string[] {
  const patterns = ['^http\\..*\\.extraheader$', '^includeIf\\.gitdir:'];
  const keys = new Set<string>();
  for (const pattern of patterns) {
    const output = tryGit(['config', '--local', '--name-only', '--get-regexp', pattern], cwd);
    if (output === undefined) continue;
    for (const line of output.split('\n')) {
      const key = line.trim();
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

function unset(cwd: string, key: string): boolean {
  return tryGit(['config', '--local', '--unset-all', key], cwd) !== undefined;
}

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

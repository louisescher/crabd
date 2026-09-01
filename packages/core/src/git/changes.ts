import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from '../forge/types.ts';
import { debug } from '../logger.ts';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}

function tryGit(args: string[], cwd: string): string | undefined {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

function readAsBase64(cwd: string, path: string): string {
  return readFileSync(join(cwd, path)).toString('base64');
}

function hashFile(cwd: string, path: string): string | undefined {
  try {
    return createHash('sha256').update(readFileSync(join(cwd, path))).digest('hex');
  } catch {
    return undefined;
  }
}

interface StatusRecord {
  status: string;
  path: string;
  renameFrom?: string;
}

function* parseStatus(out: string): Generator<StatusRecord> {
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;

    if (status[0] === 'R' || status[0] === 'C') {
      const renameFrom = fields[++i] || undefined;
      yield { status, path, renameFrom };
      continue;
    }

    yield { status, path };
  }
}

export interface BaselineEntry {
  status: string;
  hash?: string;
}

export type Baseline = Map<string, BaselineEntry>;

export function snapshotBaseline(cwd: string): Baseline {
  const baseline: Baseline = new Map();
  const out = tryGit(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  if (out === undefined) return baseline;
  for (const { status, path } of parseStatus(out)) {
    baseline.set(path, { status, hash: hashFile(cwd, path) });
  }
  return baseline;
}

export function collectChangesSinceBaseline(cwd: string, baseline: Baseline): FileChange[] {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const changes: FileChange[] = [];

  const touchedSinceBaseline = (path: string): boolean => {
    const before = baseline.get(path);
    if (!before) return true;
    return hashFile(cwd, path) !== before.hash;
  };

  for (const { status, path, renameFrom } of parseStatus(out)) {
    const x = status[0];
    const y = status[1];

    if (renameFrom !== undefined) {
      if (x === 'R' && touchedSinceBaseline(renameFrom)) changes.push({ path: renameFrom, op: 'delete' });
      if (touchedSinceBaseline(path)) changes.push({ path, op: 'upsert', contentBase64: readAsBase64(cwd, path) });
      continue;
    }

    if (!touchedSinceBaseline(path)) continue;

    // Pure deletion (in index or work tree), not also added/modified.
    if ((x === 'D' || y === 'D') && x !== 'A' && x !== 'M' && y !== 'M') {
      changes.push({ path, op: 'delete' });
      continue;
    }

    changes.push({ path, op: 'upsert', contentBase64: readAsBase64(cwd, path) });
  }

  debug(() => `collectChangesSinceBaseline: ${changes.length} change(s) in ${cwd}`);
  return changes;
}

/** Whether the working tree has any committable changes. */
export function hasChanges(cwd: string): boolean {
  return git(['status', '--porcelain=v1'], cwd).trim().length > 0;
}

/**
 * Commit operations for exactly the named paths, ignoring everything else in the working tree.
 *
 * {@link collectChangesSinceBaseline} follows the agent's own edits, which is right for a mode
 * committing the change it was asked to make and wrong for a side-effect write: a review run that
 * records a memory must not also commit whatever the agent happened to leave on disk while
 * investigating. Paths that don't exist are emitted as deletions, so removing a memory is
 * expressible through the same path.
 */
export function changesForPaths(cwd: string, paths: string[]): FileChange[] {
  const unique = [...new Set(paths)].filter(Boolean);
  return unique.map((path) => {
    try {
      return { path, op: 'upsert' as const, contentBase64: readAsBase64(cwd, path) };
    } catch {
      return { path, op: 'delete' as const };
    }
  });
}

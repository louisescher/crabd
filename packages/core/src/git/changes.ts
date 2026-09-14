import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from '../forge/types.ts';
import { debug, log } from '../logger.ts';
import { isGeneratedCredentialFile, looksLikeCredential, SensitivePathError } from './sensitive.ts';

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

/**
 * Raised when the working tree carries more changed files than a commit is allowed to hold.
 *
 * Thrown before any file is read, so the pathological case costs a `git status` and nothing else.
 */
export class TooManyChangesError extends Error {
  constructor(
    readonly fileCount: number,
    readonly maxFiles: number,
    readonly sample: string[],
  ) {
    super(`crabd: ${fileCount} files changed, over the ${maxFiles} allowed in one commit`);
    this.name = 'TooManyChangesError';
  }
}

export interface CollectOptions {
  /** Ceiling on changed files. Over it, {@link TooManyChangesError} is thrown and nothing is read. */
  maxFiles?: number;
}

interface PendingChange {
  path: string;
  op: 'upsert' | 'delete';
}

/**
 * `git status -z` reports an untracked *directory* as a single entry ending in `/` when the
 * caller did not ask for `--untracked-files=all`. crab'd does ask for it, so this is defensive:
 * handing such an entry to `readFileSync` raises `EISDIR` and takes down an otherwise-good commit
 * with an error naming nothing the reader can act on.
 */
function isDirectoryEntry(path: string): boolean {
  return path.endsWith('/');
}

export function collectChangesSinceBaseline(cwd: string, baseline: Baseline, options?: CollectOptions): FileChange[] {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const pending: PendingChange[] = [];
  const sensitive: string[] = [];

  const touchedSinceBaseline = (path: string): boolean => {
    const before = baseline.get(path);
    if (!before) return true;
    return hashFile(cwd, path) !== before.hash;
  };

  for (const { status, path, renameFrom } of parseStatus(out)) {
    const x = status[0];
    const y = status[1];

    if (renameFrom !== undefined) {
      if (x === 'R' && touchedSinceBaseline(renameFrom)) pending.push({ path: renameFrom, op: 'delete' });
      if (touchedSinceBaseline(path)) pending.push({ path, op: 'upsert' });
      continue;
    }

    if (isDirectoryEntry(path)) {
      debug(() => `collectChangesSinceBaseline: skipping untracked directory ${path}`);
      continue;
    }

    // Dropped whatever the baseline says. A workflow step wrote this into the checkout, and a
    // formatter that rewrites it makes it look like the run's own work.
    if (isGeneratedCredentialFile(path)) {
      log(`[crabd] not committing \`${path}\`: a workflow step generated it in the checkout.`);
      continue;
    }

    if (x === '?' && looksLikeCredential(path)) {
      sensitive.push(path);
      continue;
    }

    if (!touchedSinceBaseline(path)) continue;

    // Pure deletion (in index or work tree), not also added/modified.
    if ((x === 'D' || y === 'D') && x !== 'A' && x !== 'M' && y !== 'M') {
      pending.push({ path, op: 'delete' });
      continue;
    }

    pending.push({ path, op: 'upsert' });
  }

  // Fail closed, and before the ceiling: a credential in a commit is worse than a refused run, and
  // the person reading the message needs the path more than they need the file count.
  if (sensitive.length > 0) throw new SensitivePathError(sensitive);

  // The ceiling is checked on the path list, before a single file is read. A working tree that a
  // repo-wide formatter or a package manager has rewritten runs to five figures, and reading that
  // many files into base64 strings is what exhausts the heap.
  const maxFiles = options?.maxFiles;
  if (maxFiles !== undefined && maxFiles > 0 && pending.length > maxFiles) {
    throw new TooManyChangesError(
      pending.length,
      maxFiles,
      pending.slice(0, 10).map((c) => c.path),
    );
  }

  const changes: FileChange[] = pending.map((change) =>
    change.op === 'delete'
      ? { path: change.path, op: 'delete' }
      : { path: change.path, op: 'upsert', contentBase64: readAsBase64(cwd, change.path) },
  );

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

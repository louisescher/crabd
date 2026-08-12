import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FileChange } from '../forge/types.ts';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
}

function readAsBase64(cwd: string, path: string): string {
  return readFileSync(join(cwd, path)).toString('base64');
}

/**
 * Collect the working-tree changes as commit operations. Handles:
 * - added / modified / untracked → `upsert` (base64, so binary is safe);
 * - deleted → `delete`;
 * - renamed → `delete` old path + `upsert` new path.
 *
 * Uses `git status --porcelain=v1 -z` so paths with spaces/newlines parse cleanly.
 */
export function collectChanges(cwd: string): FileChange[] {
  const out = git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
  const changes: FileChange[] = [];

  // NUL-separated records. A rename/copy record is followed by an extra NUL field
  // carrying the original path.
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const record = fields[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;

    const x = status[0];
    const y = status[1];

    // Rename/copy: the next field is the original path.
    if (x === 'R' || x === 'C') {
      const original = fields[++i];
      if (original && x === 'R') changes.push({ path: original, op: 'delete' });
      changes.push({ path, op: 'upsert', contentBase64: readAsBase64(cwd, path) });
      continue;
    }

    // Pure deletion (in index or work tree), not also added/modified.
    if ((x === 'D' || y === 'D') && x !== 'A' && x !== 'M' && y !== 'M') {
      changes.push({ path, op: 'delete' });
      continue;
    }

    changes.push({ path, op: 'upsert', contentBase64: readAsBase64(cwd, path) });
  }

  return changes;
}

/** Whether the working tree has any committable changes. */
export function hasChanges(cwd: string): boolean {
  return git(['status', '--porcelain=v1'], cwd).trim().length > 0;
}

/**
 * Commit operations for exactly the named paths, ignoring everything else in the working tree.
 *
 * {@link collectChanges} sweeps the whole tree, which is right for a mode committing the change it
 * was asked to make and wrong for a side-effect write: a review run that records a memory must not
 * also commit whatever the agent happened to leave on disk while investigating. Paths that don't
 * exist are emitted as deletions, so removing a memory is expressible through the same path.
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

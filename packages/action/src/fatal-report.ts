import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where `--report-on-fatalerror` writes. Both the main container and the post container mount the
 * runner's temp directory at the same path, which is what lets the post step read a report written
 * by a process that is already gone.
 */
export function reportDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CRABD_REPORT_DIR;
  if (configured) return configured;
  if (existsSync('/github/runner_temp')) return '/github/runner_temp';
  const runnerTemp = env.RUNNER_TEMP;
  if (runnerTemp && existsSync(runnerTemp)) return runnerTemp;
  return '/tmp';
}

export interface FatalReport {
  path: string;
  /** V8's own words for what killed the process, e.g. `Allocation failed - JavaScript heap out of memory`. */
  reason: string;
  outOfMemory: boolean;
  /** The JavaScript frames at the moment of the abort, innermost first. Empty on a native-only abort. */
  stack: string[];
  heapUsedMb?: number;
  heapLimitMb?: number;
  /** The heap spaces holding the most memory, largest first. An OOM report carries no JS stack, so
   *  this is the closest the report gets to naming what filled the heap. */
  spaces?: { name: string; usedMb: number }[];
}

/** The newest node diagnostic report in `dir`, or `undefined` when the run died without writing one. */
export function readFatalReport(dir: string = reportDirectory()): FatalReport | undefined {
  let names: string[];
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('report.') && name.endsWith('.json'));
  } catch {
    return undefined;
  }
  if (names.length === 0) return undefined;

  const newest = names
    .map((name) => {
      const path = join(dir, name);
      try {
        return { path, mtime: statSync(path).mtimeMs };
      } catch {
        return { path, mtime: 0 };
      }
    })
    .sort((a, b) => b.mtime - a.mtime)[0];
  if (!newest) return undefined;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(newest.path, 'utf-8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }

  const header = (parsed.header ?? {}) as Record<string, unknown>;
  const js = (parsed.javascriptStack ?? {}) as Record<string, unknown>;
  const heap = (parsed.javascriptHeap ?? {}) as Record<string, unknown>;
  const trigger = typeof header.trigger === 'string' ? header.trigger : '';
  const event = typeof header.event === 'string' ? header.event : '';
  const reason = [trigger, event].filter(Boolean).join(': ') || 'fatal error';
  // V8 cannot walk the JS stack once the heap is exhausted, so an OOM report carries the literal
  // "Unavailable." placeholder. Dropping it keeps the log from promising a stack it doesn't have.
  const raw = Array.isArray(js.stack) ? js.stack.filter((f): f is string => typeof f === 'string') : [];
  const stack = raw.filter((frame) => frame !== 'Unavailable.');

  const spaces = Object.entries((heap.heapSpaces ?? {}) as Record<string, { used?: unknown }>)
    .map(([name, space]) => ({ name, usedMb: Math.round((typeof space?.used === 'number' ? space.used : 0) / 1_048_576) }))
    .filter((space) => space.usedMb > 0)
    .sort((a, b) => b.usedMb - a.usedMb)
    .slice(0, 3);

  return {
    path: newest.path,
    reason,
    ...(spaces.length > 0 ? { spaces } : {}),
    outOfMemory: /heap out of memory|allocation failed|oom/i.test(reason),
    stack,
    ...(typeof heap.usedMemory === 'number' ? { heapUsedMb: Math.round(heap.usedMemory / 1_048_576) } : {}),
    ...(typeof heap.memoryLimit === 'number' ? { heapLimitMb: Math.round(heap.memoryLimit / 1_048_576) } : {}),
  };
}

/** One-line-per-frame summary for the Actions log, capped so a deep stack stays readable. */
export function describeFatalReport(report: FatalReport, maxFrames = 12): string {
  const lines = [`the run aborted: ${report.reason}`];
  if (report.heapUsedMb !== undefined && report.heapLimitMb !== undefined) {
    lines.push(`  heap ${report.heapUsedMb} MB of ${report.heapLimitMb} MB`);
  }
  if (report.spaces?.length) {
    lines.push(`  largest spaces ${report.spaces.map((s) => `${s.name} ${s.usedMb} MB`).join(', ')}`);
  }
  for (const frame of report.stack.slice(0, maxFrames)) lines.push(`  at ${frame}`);
  if (report.stack.length > maxFrames) lines.push(`  ... ${report.stack.length - maxFrames} more frames`);
  return lines.join('\n');
}

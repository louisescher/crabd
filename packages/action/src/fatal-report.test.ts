import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { describeFatalReport, readFatalReport, reportDirectory, type FatalReport } from './fatal-report.ts';

describe('reportDirectory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabd-report-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('prefers CRABD_REPORT_DIR over everything else', () => {
    expect(reportDirectory({ CRABD_REPORT_DIR: '/configured/dir', RUNNER_TEMP: dir })).toBe('/configured/dir');
  });

  it('falls back to RUNNER_TEMP when that directory exists', () => {
    expect(reportDirectory({ RUNNER_TEMP: dir })).toBe(dir);
  });

  it('falls back to /tmp when RUNNER_TEMP does not exist', () => {
    expect(reportDirectory({ RUNNER_TEMP: '/nonexistent/does-not-exist' })).toBe('/tmp');
  });

  it('falls back to /tmp when nothing is configured', () => {
    expect(reportDirectory({})).toBe('/tmp');
  });
});

describe('readFatalReport', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabd-fatal-'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns undefined for a directory with no report.*.json', () => {
    writeFileSync(join(dir, 'not-a-report.txt'), 'hello');
    expect(readFatalReport(dir)).toBeUndefined();
  });

  it('returns undefined for a directory that does not exist', () => {
    expect(readFatalReport(join(dir, 'missing'))).toBeUndefined();
  });

  it('recognizes an out-of-memory report', () => {
    const report = {
      header: { trigger: 'OOMError', event: 'Allocation failed - JavaScript heap out of memory' },
      javascriptStack: { message: 'No stack.', stack: ['Unavailable.'] },
      javascriptHeap: { usedMemory: 66723544, memoryLimit: 268435456 },
    };
    writeFileSync(join(dir, 'report.20260914.100845.12084.0.001.json'), JSON.stringify(report));

    const result = readFatalReport(dir);
    expect(result).toBeDefined();
    expect(result!.outOfMemory).toBe(true);
    expect(result!.reason).toContain('OOMError');
    expect(result!.reason).toContain('Allocation failed - JavaScript heap out of memory');
    expect(result!.stack).toEqual([]);
    expect(result!.heapUsedMb).toBe(64);
    expect(result!.heapLimitMb).toBe(256);
  });

  it('keeps the frames of a non-OOM report and marks it not out of memory', () => {
    const report = {
      header: { trigger: 'FatalError', event: 'Unhandled exception' },
      javascriptStack: {
        message: 'Stack trace.',
        stack: ['at Foo (/repo/foo.js:1:1)', 'at Bar (/repo/bar.js:2:2)'],
      },
      javascriptHeap: { usedMemory: 1_048_576, memoryLimit: 268435456 },
    };
    writeFileSync(join(dir, 'report.20260914.100845.12084.0.002.json'), JSON.stringify(report));

    const result = readFatalReport(dir);
    expect(result).toBeDefined();
    expect(result!.outOfMemory).toBe(false);
    expect(result!.stack).toEqual(['at Foo (/repo/foo.js:1:1)', 'at Bar (/repo/bar.js:2:2)']);
  });

  it('picks the newest report by mtime when several are present', () => {
    const older = {
      header: { trigger: 'FatalError', event: 'older event' },
      javascriptStack: { message: 'No stack.', stack: [] },
      javascriptHeap: {},
    };
    const newer = {
      header: { trigger: 'FatalError', event: 'newer event' },
      javascriptStack: { message: 'No stack.', stack: [] },
      javascriptHeap: {},
    };
    const olderPath = join(dir, 'report.20260914.100845.12084.0.001.json');
    const newerPath = join(dir, 'report.20260914.100845.12084.0.002.json');
    writeFileSync(olderPath, JSON.stringify(older));
    writeFileSync(newerPath, JSON.stringify(newer));

    const oldTime = new Date('2026-01-01T00:00:00Z');
    const newTime = new Date('2026-06-01T00:00:00Z');
    utimesSync(olderPath, oldTime, oldTime);
    utimesSync(newerPath, newTime, newTime);

    const result = readFatalReport(dir);
    expect(result?.reason).toContain('newer event');
  });

  it('returns undefined for malformed JSON', () => {
    writeFileSync(join(dir, 'report.20260914.100845.12084.0.003.json'), '{not json');
    expect(readFatalReport(dir)).toBeUndefined();
  });
});

describe('describeFatalReport', () => {
  function makeReport(overrides: Partial<FatalReport> = {}): FatalReport {
    return {
      path: '/tmp/report.json',
      reason: 'OOMError: Allocation failed - JavaScript heap out of memory',
      outOfMemory: true,
      stack: [],
      ...overrides,
    };
  }

  it('puts the reason on the first line', () => {
    const lines = describeFatalReport(makeReport()).split('\n');
    expect(lines[0]).toBe('the run aborted: OOMError: Allocation failed - JavaScript heap out of memory');
  });

  it('shows the heap line when both numbers are present', () => {
    const body = describeFatalReport(makeReport({ heapUsedMb: 64, heapLimitMb: 256 }));
    expect(body).toContain('heap 64 MB of 256 MB');
  });

  it('omits the heap line when the numbers are absent', () => {
    const body = describeFatalReport(makeReport({ reason: 'FatalError: Unhandled exception' }));
    expect(body).not.toContain('heap');
  });

  it('renders one "at <frame>" line per frame', () => {
    const body = describeFatalReport(makeReport({ stack: ['Foo (a.js:1:1)', 'Bar (b.js:2:2)'] }));
    expect(body).toContain('  at Foo (a.js:1:1)');
    expect(body).toContain('  at Bar (b.js:2:2)');
  });

  it('truncates past maxFrames with a "... N more frames" line', () => {
    const stack = Array.from({ length: 15 }, (_, i) => `frame${i} (f.js:${i}:1)`);
    const body = describeFatalReport(makeReport({ stack }), 12);

    expect(body).toContain('at frame11 (f.js:11:1)');
    expect(body).not.toContain('at frame12 (f.js:12:1)');
    expect(body).toContain('... 3 more frames');
  });
});

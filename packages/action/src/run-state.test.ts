import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeRepo } from '@crabd/core';
import { readRunState, readStateFile, saveRunState, type RunState } from './run-state.ts';

const repo: ForgeRepo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    version: 1,
    forge: 'github',
    repo,
    tracking: { id: 99, target: 8 },
    subject: 8,
    mode: 'review',
    branding: { name: "crab'd", emoji: '🦀', footer: true },
    finalized: false,
    ...overrides,
  };
}

describe('saveRunState / readStateFile', () => {
  let dir: string;
  let stateFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabd-state-'));
    stateFile = join(dir, 'state.env');
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('round-trips a state through a GITHUB_STATE file', () => {
    const state = makeState();
    saveRunState(state, { GITHUB_STATE: stateFile });

    const raw = readStateFile(stateFile);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw!)).toEqual(state);
  });

  it('keeps the last write when saved twice, the way a run records finalized: true', () => {
    saveRunState(makeState({ finalized: false }), { GITHUB_STATE: stateFile });
    saveRunState(makeState({ finalized: true }), { GITHUB_STATE: stateFile });

    const raw = readStateFile(stateFile);
    expect(JSON.parse(raw!).finalized).toBe(true);
  });

  it('falls back to a save-state workflow command on stdout when GITHUB_STATE is unset', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const state = makeState();
      saveRunState(state, {});

      expect(write).toHaveBeenCalledTimes(1);
      const line = write.mock.calls[0]?.[0] as string;
      expect(line).toBe(`::save-state name=crabd::${JSON.stringify(state)}\n`);
    } finally {
      write.mockRestore();
    }
  });

  it('never touches a state file when falling back to stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      saveRunState(makeState(), {});
      expect(() => readFileSync(stateFile)).toThrow();
    } finally {
      write.mockRestore();
    }
  });
});

describe('readRunState', () => {
  it('parses a valid, current-version state', () => {
    const state = makeState();
    const env = { [`STATE_crabd`]: JSON.stringify(state) };
    expect(readRunState(env)).toEqual(state);
  });

  it('returns undefined when the env var is absent', () => {
    expect(readRunState({})).toBeUndefined();
  });

  it('returns undefined for malformed JSON', () => {
    expect(readRunState({ STATE_crabd: '{not json' })).toBeUndefined();
  });

  it('returns undefined for a state with the wrong version', () => {
    const state = { ...makeState(), version: 2 };
    expect(readRunState({ STATE_crabd: JSON.stringify(state) })).toBeUndefined();
  });

  it('returns undefined for a value with no version field at all', () => {
    expect(readRunState({ STATE_crabd: JSON.stringify({ mode: 'review' }) })).toBeUndefined();
  });
});

describe('readStateFile', () => {
  it('returns undefined for a file that does not exist', () => {
    expect(readStateFile('/nonexistent/path/does-not-exist.env')).toBeUndefined();
  });
});

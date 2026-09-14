import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNNING_MARKER } from '@crabd/core';
import type { ForgeAdapter, ForgeRepo, TrackingComment } from '@crabd/core';
import type { RunState } from './run-state.ts';

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

function fakeAdapter(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    kind: 'github',
    repo,
    getContext: vi.fn(),
    resolveActor: vi.fn(),
    createTrackingComment: vi.fn(async (target: number): Promise<TrackingComment> => ({ id: 99, target })),
    findTrackingComment: vi.fn(async () => undefined),
    reactToComment: vi.fn(async () => {}),
    updateTrackingComment: vi.fn(async () => {}),
    replyToReviewComment: vi.fn(async () => {}),
    postReview: vi.fn(async () => {}),
    listReviewThreads: vi.fn(async () => []),
    listReviews: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => true),
    listChecks: vi.fn(async () => ({ available: true, checks: [] })),
    commitToBranch: vi.fn(async () => {}),
    updateBranch: vi.fn(async () => ({ status: 'up-to-date' }) as const),
    openOrUpdatePR: vi.fn(async () => ({ number: 8, url: 'http://pr/8' })),
    readOrgConfig: vi.fn(async () => undefined),
    checkRepoAccess: vi.fn(async () => 'ok' as const),
    ...overrides,
  };
}

interface Loaded {
  adapter: ForgeAdapter;
  buildForge: ReturnType<typeof vi.fn>;
  exitSpy: ReturnType<typeof vi.spyOn>;
}

async function loadPost(options: {
  state?: RunState;
  adapter?: ForgeAdapter;
  buildForgeError?: Error;
}): Promise<Loaded> {
  vi.resetModules();

  vi.doMock('./run-state.ts', () => ({
    readRunState: vi.fn(() => options.state),
  }));

  const adapter = options.adapter ?? fakeAdapter();
  const buildForge = options.buildForgeError
    ? vi.fn(() => {
        throw options.buildForgeError;
      })
    : vi.fn(() => ({ adapter, auth: {}, strategy: 'static' }));

  vi.doMock('./forge-factory.ts', () => ({
    buildForge,
    detectForge: vi.fn(() => 'github'),
  }));

  vi.doMock('./logger.ts', () => ({
    log: vi.fn(),
    warn: vi.fn(),
  }));

  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

  await import('./post.ts');
  await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

  return { adapter, buildForge, exitSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('post', () => {
  it('does nothing and exits 0 when there is no recorded run state', async () => {
    const { buildForge, exitSpy } = await loadPost({ state: undefined });

    expect(buildForge).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('does nothing and exits 0 when the run already finalized', async () => {
    const { buildForge, exitSpy } = await loadPost({ state: makeState({ finalized: true }) });

    expect(buildForge).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('leaves the comment alone when no tracking comment is found', async () => {
    const adapter = fakeAdapter({ findTrackingComment: vi.fn(async () => undefined) });
    const { exitSpy } = await loadPost({ state: makeState(), adapter });

    expect(adapter.updateTrackingComment).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("leaves the comment alone when its body no longer carries the running marker", async () => {
    const adapter = fakeAdapter({
      findTrackingComment: vi.fn(async () => ({ id: 99, target: 8, body: 'all done, no marker here' })),
    });
    const { exitSpy } = await loadPost({ state: makeState(), adapter });

    expect(adapter.updateTrackingComment).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('rewrites the comment when it still carries the running marker', async () => {
    const adapter = fakeAdapter({
      findTrackingComment: vi.fn(async () => ({ id: 99, target: 8, body: `${RUNNING_MARKER}\nstill working` })),
    });
    const { exitSpy } = await loadPost({ state: makeState(), adapter });

    expect(adapter.updateTrackingComment).toHaveBeenCalledTimes(1);
    const [ref, body] = vi.mocked(adapter.updateTrackingComment).mock.calls[0]!;
    expect(ref).toEqual({ id: 99, target: 8 });
    expect(body).toContain('stopped unexpectedly');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('resolves 0 even when buildForge throws', async () => {
    const { buildForge, exitSpy } = await loadPost({
      state: makeState(),
      buildForgeError: new Error('no credentials'),
    });

    expect(buildForge).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { resolveConfig } from '@crabd/config';
import type { ForgeAdapter, ForgeContext, ForgeEvent, PullRequestRef, TrackingComment } from '../forge/types.ts';
import { MEMORY_MARKER, TRACKING_MARKER } from '../report/tracking.ts';
import { registerMode } from '../modes/registry.ts';
import type { RunPlan } from './prepare.ts';
import { finalizeRun } from './finalize.ts';

const repo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };

registerMode({
  name: 'noop-test-mode',
  outputSchema: v.unknown(),
  tools: [],
  finalize: async () => ({ summary: 'the answer' }),
});

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
    postReview: vi.fn(async () => {}),
    commitToBranch: vi.fn(async () => {}),
    openOrUpdatePR: vi.fn(async (): Promise<PullRequestRef> => ({ number: 8, url: 'http://pr/8' })),
    readOrgConfig: vi.fn(async () => undefined),
    checkRepoAccess: vi.fn(async () => 'ok' as const),
    ...overrides,
  };
}

const context: ForgeContext = {
  repo,
  pullRequest: {
    number: 8, title: 'feat', body: '', author: 'lescher', labels: [], state: 'open',
    headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false, isDraft: false,
  },
  comments: [],
  changedFiles: [],
};

const event: ForgeEvent = {
  forge: 'github',
  kind: 'issue_comment',
  action: 'created',
  repo,
  actor: { login: 'lescher', association: 'MEMBER', isBot: false },
  pullRequest: context.pullRequest,
  comment: { id: 5, body: 'that is wrong, this is intentional', author: 'lescher', createdAt: '' },
  isPullRequest: true,
  raw: {},
};

const config = (writesAllowed: boolean) =>
  resolveConfig({
    layers: {
      repo: {
        model: 'openai/gpt-5',
        providers: { allowlist: ['openai'] },
        permissions: { write: writesAllowed },
      },
    },
  });

function plan(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    mode: 'noop-test-mode',
    model: 'openai/gpt-5',
    thinkingLevel: 'medium',
    instructions: '',
    message: '',
    toolNames: [],
    tracking: { id: 1, target: 8 },
    subject: 8,
    branding: { name: "crab'd", emoji: '🦀', footer: true },
    memory: { dir: '.crabd/memory', writable: true, write: 'branch' },
    ...overrides,
  } as RunPlan;
}

describe('finalizeRun: memory gets its own comment', () => {
  it('creates a dedicated memory comment and keeps it off the pinned tracking comment', async () => {
    const adapter = fakeAdapter();
    await finalizeRun({
      adapter,
      config: config(true),
      event,
      context,
      trigger: { explicit: true } as never,
      plan: plan(),
      data: {},
      cwd: '/repo',
      memories: { root: '/tmp/staged', paths: ['.crabd/memory/no-barrel-files.md'] },
    });

    // The pinned tracking comment only carries the mode's own answer.
    expect(adapter.updateTrackingComment).toHaveBeenCalledWith(
      { id: 1, target: 8 },
      expect.stringContaining('the answer'),
    );
    const pinnedCall = vi.mocked(adapter.updateTrackingComment).mock.calls[0]![1] as string;
    expect(pinnedCall).not.toContain('🧠');
    expect(pinnedCall).not.toContain(MEMORY_MARKER);

    // A new, separate comment carries the memory note instead.
    expect(adapter.findTrackingComment).toHaveBeenCalledWith(8, MEMORY_MARKER);
    expect(adapter.createTrackingComment).toHaveBeenCalledWith(8, expect.stringContaining('🧠'));
    const memoryBody = vi.mocked(adapter.createTrackingComment).mock.calls[0]![1] as string;
    expect(memoryBody.endsWith(MEMORY_MARKER)).toBe(true);
    expect(memoryBody).not.toContain(TRACKING_MARKER);
  });

  it('updates the existing memory comment on a later run instead of creating a duplicate', async () => {
    const findTrackingComment = vi.fn(async (target: number, marker?: string) =>
      marker === MEMORY_MARKER ? { id: 42, target } : undefined,
    );
    const adapter = fakeAdapter({ findTrackingComment });
    await finalizeRun({
      adapter,
      config: config(true),
      event,
      context,
      trigger: { explicit: true } as never,
      plan: plan(),
      data: {},
      cwd: '/repo',
      memories: { root: '/tmp/staged', paths: ['.crabd/memory/no-barrel-files.md'] },
    });

    expect(adapter.createTrackingComment).not.toHaveBeenCalled();
    // First update call is the pinned comment (id 1); the second is the memory comment (id 42).
    expect(adapter.updateTrackingComment).toHaveBeenNthCalledWith(2, { id: 42, target: 8 }, expect.stringContaining('🧠'));
  });

  it('leaves the pinned comment as the only comment when nothing was recorded', async () => {
    const adapter = fakeAdapter();
    await finalizeRun({
      adapter,
      config: config(true),
      event,
      context,
      trigger: { explicit: true } as never,
      plan: plan(),
      data: {},
      cwd: '/repo',
      memories: { root: '/tmp/staged', paths: [] },
    });

    expect(adapter.createTrackingComment).not.toHaveBeenCalled();
    expect(adapter.findTrackingComment).not.toHaveBeenCalled();
    expect(adapter.updateTrackingComment).toHaveBeenCalledTimes(1);
  });
});

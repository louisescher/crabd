import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '@crabd/config';
import type {
  ForgeAdapter,
  ForgeContext,
  ForgeEvent,
  PullRequestRef,
  TrackingComment,
} from '../forge/types.ts';
import { registerBuiltinModes } from '../modes/builtins.ts';
import { prepareRun, type ClassifyRequest } from './prepare.ts';

registerBuiltinModes();

const repo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };

function fakeAdapter(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  return {
    kind: 'forgejo',
    repo,
    getContext: vi.fn(
      async (): Promise<ForgeContext> => ({
        repo,
        pullRequest: {
          number: 8, title: 'feat', body: '', author: 'lescher', labels: [], state: 'open',
          headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false,
        },
        comments: [],
        changedFiles: [],
      }),
    ),
    resolveActor: vi.fn(),
    createTrackingComment: vi.fn(async (target: number): Promise<TrackingComment> => ({ id: 1, target })),
    findTrackingComment: vi.fn(async () => undefined),
    reactToComment: vi.fn(async () => {}),
    updateTrackingComment: vi.fn(async () => {}),
    postReview: vi.fn(async () => {}),
    commitToBranch: vi.fn(async () => {}),
    openOrUpdatePR: vi.fn(async (): Promise<PullRequestRef> => ({ number: 8, url: 'http://pr/8' })),
    readOrgConfig: vi.fn(async () => undefined),
    ...overrides,
  };
}

function commentEvent(body: string): ForgeEvent {
  return {
    forge: 'github',
    kind: 'issue_comment',
    action: 'created',
    repo,
    actor: { login: 'lescher', association: 'MEMBER', isBot: false },
    issue: { number: 8, title: 'feat', body: '', author: 'lescher', labels: [], state: 'open' },
    comment: { id: 5, body, author: 'lescher', createdAt: '' },
    isPullRequest: true,
    raw: {},
  };
}

function prEvent(forge: 'github' | 'forgejo', association: string): ForgeEvent {
  return {
    forge,
    kind: 'pull_request',
    action: 'opened',
    repo,
    actor: { login: 'lescher', association, isBot: false },
    pullRequest: {
      number: 8, title: 'feat', body: '', author: 'lescher', labels: [], state: 'open',
      headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false,
    },
    raw: {},
  };
}

const config = (allowed: string[]) =>
  resolveConfig({
    layers: {
      repo: {
        model: 'openai/gpt-5',
        providers: { allowlist: ['openai'] },
        permissions: { allowed_associations: allowed },
      },
    },
  });

describe('prepareRun actor resolution', () => {
  it('resolves a Forgejo actor (whose payload association is always NONE) via the forge and admits it', async () => {
    const resolveActor = vi.fn(async () => ({ login: 'lescher', association: 'OWNER', isBot: false }));
    const adapter = fakeAdapter({ resolveActor });
    const outcome = await prepareRun({ adapter, config: config(['OWNER']), event: prEvent('forgejo', 'NONE'), cwd: '/nonexistent' });
    expect(resolveActor).toHaveBeenCalledWith('lescher');
    expect(outcome.status).toBe('run');
  });

  it('gates on the RESOLVED association, not the payload NONE (denies when the resolved role is not allowlisted)', async () => {
    const resolveActor = vi.fn(async () => ({ login: 'lescher', association: 'COLLABORATOR', isBot: false }));
    const adapter = fakeAdapter({ resolveActor });
    const outcome = await prepareRun({ adapter, config: config(['OWNER']), event: prEvent('forgejo', 'NONE'), cwd: '/nonexistent' });
    expect(resolveActor).toHaveBeenCalledOnce();
    expect(outcome.status).toBe('denied');
    if (outcome.status === 'denied') expect(outcome.reason).toMatch(/COLLABORATOR/);
  });

  it('fails safe: if forge resolution throws, the actor stays NONE and is denied', async () => {
    const resolveActor = vi.fn(async () => {
      throw new Error('403 forbidden');
    });
    const adapter = fakeAdapter({ resolveActor });
    const outcome = await prepareRun({ adapter, config: config(['OWNER']), event: prEvent('forgejo', 'NONE'), cwd: '/nonexistent' });
    expect(outcome.status).toBe('denied');
    if (outcome.status === 'denied') expect(outcome.reason).toMatch(/NONE/);
  });

  it('does NOT call resolveActor on GitHub (the payload carries a real author_association)', async () => {
    const resolveActor = vi.fn();
    const adapter = fakeAdapter({ kind: 'github', resolveActor });
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: prEvent('github', 'MEMBER'), cwd: '/nonexistent' });
    expect(resolveActor).not.toHaveBeenCalled();
    expect(outcome.status).toBe('run');
  });
});

describe('prepareRun mention classification', () => {
  it('routes a bare mention to the classified mode (review) — the full review turn, not a comment', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async (_req: ClassifyRequest) => ({ mode: 'review' }));
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd please review again'),
      cwd: '/nonexistent',
      classify,
    });
    expect(classify).toHaveBeenCalledOnce();
    const req = classify.mock.calls[0]![0];
    // All enabled modes are offered (incl. mention itself), with the comment + PR context.
    expect(req.candidates.map((c) => c.name).sort()).toEqual(['implement', 'mention', 'review']);
    expect(req.comment).toBe('/crabd please review again');
    expect(req.isPullRequest).toBe(true);
    expect(outcome.status).toBe('run');
    if (outcome.status === 'run') {
      expect(outcome.plan.mode).toBe('review');
      expect(outcome.plan.toolNames).toEqual(['comment', 'review']); // review mode's tools, not mention's
      expect(outcome.trigger.mode).toBe('review');
    }
  });

  it('does NOT classify an explicit keyword mention (the keyword is authoritative)', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async () => ({ mode: 'mention' }));
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd review'),
      cwd: '/nonexistent',
      classify,
    });
    expect(classify).not.toHaveBeenCalled();
    if (outcome.status === 'run') expect(outcome.plan.mode).toBe('review');
  });

  it('does NOT classify a non-comment event (PR opened is unambiguous)', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async () => ({ mode: 'mention' }));
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: prEvent('github', 'MEMBER'),
      cwd: '/nonexistent',
      classify,
    });
    expect(classify).not.toHaveBeenCalled();
    if (outcome.status === 'run') expect(outcome.plan.mode).toBe('review');
  });

  it('keeps mention when the classifier throws (fail-soft)', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async () => {
      throw new Error('classify subprocess died');
    });
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd take another look'),
      cwd: '/nonexistent',
      classify,
    });
    expect(classify).toHaveBeenCalledOnce();
    if (outcome.status === 'run') expect(outcome.plan.mode).toBe('mention');
  });

  it('keeps mention when the classifier returns an unregistered/disabled mode', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async () => ({ mode: 'nonsense' }));
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd take another look'),
      cwd: '/nonexistent',
      classify,
    });
    if (outcome.status === 'run') expect(outcome.plan.mode).toBe('mention');
  });

  it('runs without a classifier — a bare mention stays mention', async () => {
    const adapter = fakeAdapter();
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd what does this do?'),
      cwd: '/nonexistent',
    });
    if (outcome.status === 'run') expect(outcome.plan.mode).toBe('mention');
  });
});

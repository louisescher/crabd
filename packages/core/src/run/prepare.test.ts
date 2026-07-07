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
import { prepareRun } from './prepare.ts';

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

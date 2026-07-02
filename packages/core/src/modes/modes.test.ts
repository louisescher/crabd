import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '@crabd/config';
import type {
  ForgeAdapter,
  ForgeContext,
  ForgeEvent,
  PullRequestRef,
  ReviewSubmission,
  TrackingComment,
} from '../forge/types.ts';
import { registerBuiltinModes } from './builtins.ts';
import { getMode, listModes } from './registry.ts';
import { reviewMode } from './review.ts';
import { renderResult, renderWorking } from '../report/tracking.ts';

registerBuiltinModes();

function fakeAdapter(overrides: Partial<ForgeAdapter> = {}): ForgeAdapter {
  const repo = { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true };
  return {
    kind: 'github',
    repo,
    getContext: vi.fn(),
    resolveActor: vi.fn(),
    createTrackingComment: vi.fn(async (target: number): Promise<TrackingComment> => ({ id: 1, target })),
    findTrackingComment: vi.fn(async () => undefined),
    reactToComment: vi.fn(async () => {}),
    updateTrackingComment: vi.fn(async () => {}),
    postReview: vi.fn(async () => {}),
    commitToBranch: vi.fn(async () => {}),
    openOrUpdatePR: vi.fn(async (): Promise<PullRequestRef> => ({ number: 2, url: 'http://pr/2' })),
    readOrgConfig: vi.fn(async () => undefined),
    ...overrides,
  };
}

const baseContext: ForgeContext = {
  repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
  pullRequest: {
    number: 5, title: 'Feature', body: 'body', author: 'dev', labels: [], state: 'open',
    headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false,
  },
  comments: [],
  changedFiles: [],
};

const baseEvent: ForgeEvent = {
  forge: 'github', kind: 'pull_request', action: 'opened',
  repo: baseContext.repo,
  actor: { login: 'dev', association: 'MEMBER', isBot: false },
  pullRequest: baseContext.pullRequest,
  raw: {},
};

describe('mode registry', () => {
  it('registers the three built-in modes', () => {
    expect(listModes().sort()).toEqual(['implement', 'mention', 'review']);
    expect(getMode('review')).toBe(reviewMode);
  });
});

describe('review mode finalize', () => {
  it('posts a review with the verdict and inline findings', async () => {
    const adapter = fakeAdapter();
    const result = await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review' },
      cwd: '/tmp',
      data: {
        summary: 'Looks mostly good.',
        verdict: 'REQUEST_CHANGES',
        findings: [{ path: 'src/a.ts', line: 12, body: 'Guard against null.' }],
      },
    });

    expect(adapter.postReview).toHaveBeenCalledTimes(1);
    const [prNumber, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [
      number,
      ReviewSubmission,
    ];
    expect(prNumber).toBe(5);
    expect(submission.event).toBe('REQUEST_CHANGES');
    expect(submission.comments).toHaveLength(1);
    expect(result.summary).toMatch(/REQUEST_CHANGES/);
  });
});

describe('tracking comment rendering', () => {
  it('renders a working comment for each mode', () => {
    expect(renderWorking('review')).toMatch(/reviewing this pull request/);
    expect(renderWorking('mention')).toMatch(/crab'd/);
  });
  it('renders a result with an optional PR link', () => {
    const body = renderResult({ mode: 'implement', summary: 'Done', prUrl: 'http://pr/2' });
    expect(body).toMatch(/Done/);
    expect(body).toMatch(/http:\/\/pr\/2/);
  });
});

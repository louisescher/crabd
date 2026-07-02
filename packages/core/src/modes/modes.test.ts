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
    // The forge API still receives the raw enum...
    expect(submission.event).toBe('REQUEST_CHANGES');
    expect(submission.comments).toHaveLength(1);
    // ...but the human-facing summary uses a plain-language verdict.
    expect(result.summary).toMatch(/Please address the findings before merging\./);
    expect(result.summary).toMatch(/\(1 inline finding\)/);
    // The tracking comment must NOT repeat the full review body (avoids the duplicate
    // comment): it carries only a short verdict pointer.
    expect(result.trackingComment).toBeDefined();
    expect(result.trackingComment).not.toContain('Looks mostly good.');
    expect(result.trackingComment).toMatch(/Reviewed this pull request/);
    expect(result.trackingComment).toMatch(/Please address the findings before merging\./);
  });

  it('comment_only forces a COMMENT review while keeping the verdict in the summary', async () => {
    const adapter = fakeAdapter();
    const config = resolveConfig({ layers: { repo: { review: { comment_only: true } } } });
    const result = await reviewMode.finalize({
      adapter,
      config,
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review' },
      cwd: '/tmp',
      data: { summary: 'Ship it.', verdict: 'APPROVE', findings: [] },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    expect(submission.event).toBe('COMMENT'); // never APPROVE/REQUEST_CHANGES
    expect(result.summary).toMatch(/Good to merge \(LGTM\)\./); // verdict still shown
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

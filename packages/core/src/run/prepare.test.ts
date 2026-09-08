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
import { DEFAULT_BRANDING, isRoundHandled, PR_MARKER, renderWorking } from '../report/tracking.ts';

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
          headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false, isDraft: false,
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
    replyToReviewComment: vi.fn(async () => {}),
    postReview: vi.fn(async () => {}),
    listReviewThreads: vi.fn(async () => []),
    listReviews: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => true),
    listChecks: vi.fn(async () => ({ available: true, checks: [] })),
    commitToBranch: vi.fn(async () => {}),
    openOrUpdatePR: vi.fn(async (): Promise<PullRequestRef> => ({ number: 8, url: 'http://pr/8' })),
    readOrgConfig: vi.fn(async () => undefined),
    checkRepoAccess: vi.fn(async () => 'ok' as const),
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
      headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false, isDraft: false,
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

describe('prepareRun with writes disabled', () => {
  const readOnly = () =>
    resolveConfig({
      layers: {
        repo: {
          model: 'openai/gpt-5',
          providers: { allowlist: ['openai'] },
          permissions: { allowed_associations: ['MEMBER'], write: false },
        },
      },
    });

  it('drops the write-only implement mode from the classifier candidates', async () => {
    const adapter = fakeAdapter();
    const classify = vi.fn(async (_req: ClassifyRequest) => ({ mode: 'review' }));
    await prepareRun({
      adapter,
      config: readOnly(),
      event: commentEvent('/crabd have another look'),
      cwd: '/nonexistent',
      classify,
    });
    expect(classify.mock.calls[0]![0].candidates.map((c) => c.name).sort()).toEqual(['mention', 'review']);
  });

  it('refuses to route to implement even when named explicitly', async () => {
    const adapter = fakeAdapter();
    const outcome = await prepareRun({
      adapter,
      config: readOnly(),
      event: commentEvent('/crabd implement the retry logic'),
      cwd: '/nonexistent',
    });
    expect(outcome.status).toBe('skip');
  });

  it('strips the write tools from a mode that can still run read-only', async () => {
    const adapter = fakeAdapter();
    const outcome = await prepareRun({
      adapter,
      config: readOnly(),
      event: commentEvent('/crabd what does this do?'),
      cwd: '/nonexistent',
    });
    if (outcome.status === 'run') {
      expect(outcome.plan.mode).toBe('mention');
      expect(outcome.plan.toolNames).toEqual(['comment']); // 'commit' dropped
    }
  });

  it('leaves a read-only mode untouched', async () => {
    const adapter = fakeAdapter();
    const outcome = await prepareRun({
      adapter,
      config: readOnly(),
      event: prEvent('github', 'MEMBER'),
      cwd: '/nonexistent',
    });
    if (outcome.status === 'run') {
      expect(outcome.plan.mode).toBe('review');
      expect(outcome.plan.toolNames).toEqual(['comment', 'review']);
    }
  });
});

describe('prepareRun idempotency guard', () => {
  it('skips a comment already claimed by a previous run, before any write', async () => {
    const findTrackingComment = vi.fn(async () => ({
      id: 1,
      target: 8,
      body: 'crab\'d is working...\n<!-- crabd:handled:5 -->\n<!-- crabd:tracking -->',
    }));
    const adapter = fakeAdapter({ findTrackingComment });
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd review'),
      cwd: '/nonexistent',
    });
    expect(outcome.status).toBe('skip');
    if (outcome.status === 'skip') expect(outcome.reason).toMatch(/duplicate trigger/);
    expect(adapter.reactToComment).not.toHaveBeenCalled();
    expect(adapter.createTrackingComment).not.toHaveBeenCalled();
  });

  it('proceeds normally for a different comment id on the same subject', async () => {
    const findTrackingComment = vi.fn(async () => ({
      id: 1,
      target: 8,
      body: 'crab\'d is working...\n<!-- crabd:handled:999 -->\n<!-- crabd:tracking -->',
    }));
    const adapter = fakeAdapter({ findTrackingComment });
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd review'),
      cwd: '/nonexistent',
    });
    expect(outcome.status).toBe('run');
  });

  it('fails open when the tracking-comment lookup throws', async () => {
    const findTrackingComment = vi.fn(async () => undefined).mockImplementationOnce(async () => {
      throw new Error('network blip');
    });
    const adapter = fakeAdapter({ findTrackingComment });
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: commentEvent('/crabd review'),
      cwd: '/nonexistent',
    });
    expect(outcome.status).toBe('run');
  });

  it('does not guard a non-comment event (no event.comment to dedup on)', async () => {
    const findTrackingComment = vi.fn(async () => undefined);
    const adapter = fakeAdapter({ findTrackingComment });
    const outcome = await prepareRun({
      adapter,
      config: config(['MEMBER']),
      event: prEvent('github', 'MEMBER'),
      cwd: '/nonexistent',
    });
    expect(outcome.status).toBe('run');
  });
});

describe('prepareRun feedback rounds', () => {
  const ownPr = {
    number: 8, title: 'feat', body: `body\n\n${PR_MARKER}`, author: 'crabd', labels: [], state: 'open',
    headRef: 'crabd/implement-3', baseRef: 'main', headSha: 'headsha', fromFork: false, isDraft: false,
  };

  const reviewEvent = (): ForgeEvent => ({
    forge: 'github',
    kind: 'pull_request_review',
    action: 'submitted',
    repo,
    actor: { login: 'lescher', association: 'MEMBER', isBot: false },
    pullRequest: ownPr,
    review: { id: 90, state: 'changes_requested', body: 'needs work', author: 'lescher', submittedAt: '' },
    comment: { id: 90, body: 'needs work', author: 'lescher', createdAt: '' },
    raw: {},
  });

  const thread = {
    id: 'T1', rootCommentId: 40, path: 'src/a.ts', line: 3, isResolved: false, rootIsCrabd: false,
    comments: [{ id: 40, author: 'lescher', body: 'this leaks', createdAt: '' }],
  };

  const roundAdapter = (overrides: Partial<ForgeAdapter> = {}) =>
    fakeAdapter({
      getContext: vi.fn(async () => ({ repo, pullRequest: ownPr, comments: [], changedFiles: [] })),
      listReviewThreads: vi.fn(async () => [thread]),
      listReviews: vi.fn(async () => [
        { id: 90, state: 'changes_requested' as const, body: 'needs work', author: 'lescher', submittedAt: '' },
      ]),
      ...overrides,
    });

  it('fetches the conversations, the reviews and the check state, and claims the round', async () => {
    const adapter = roundAdapter();
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    expect(outcome.status).toBe('run');
    if (outcome.status !== 'run') return;
    expect(adapter.listReviewThreads).toHaveBeenCalledWith(8);
    expect(adapter.listChecks).toHaveBeenCalledWith('headsha');
    expect(outcome.context.reviewThreads).toEqual([thread]);
    expect(outcome.plan.verbKey).toBe('implement:round');
    expect(outcome.plan.branding.roundClaim).toEqual({ headSha: 'headsha', feedbackToken: '90.40.1' });
    const posted = vi.mocked(adapter.createTrackingComment).mock.calls[0]?.[1] ?? '';
    expect(posted).toContain('addressing the feedback');
    expect(isRoundHandled(posted, 'headsha', '90.40.1')).toBe(true);
  });

  it('skips a round another run already claimed', async () => {
    const claimed = renderWorking(
      { ...DEFAULT_BRANDING, roundClaim: { headSha: 'headsha', feedbackToken: '90.40.1' } },
      'implement:round',
    );
    const adapter = roundAdapter({
      findTrackingComment: vi.fn(async () => ({ id: 1, target: 8, body: claimed })),
    });
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    expect(outcome.status).toBe('skip');
    if (outcome.status === 'skip') expect(outcome.reason).toMatch(/already handled/);
  });

  it('runs again once the feedback has moved on', async () => {
    const claimed = renderWorking(
      { ...DEFAULT_BRANDING, roundClaim: { headSha: 'headsha', feedbackToken: '90.40.1' } },
      'implement:round',
    );
    const adapter = roundAdapter({
      findTrackingComment: vi.fn(async () => ({ id: 1, target: 8, body: claimed })),
      listReviewThreads: vi.fn(async () => [
        { ...thread, comments: [...thread.comments, { id: 41, author: 'lescher', body: 'and this', createdAt: '' }] },
      ]),
    });
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    expect(outcome.status).toBe('run');
  });

  it('never reacts to a submitted review, which has no reaction endpoint', async () => {
    const adapter = roundAdapter();
    await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    expect(adapter.reactToComment).not.toHaveBeenCalled();
  });

  it('warns when it could not read the conversations, rather than committing blind in silence', async () => {
    const adapter = roundAdapter({
      listReviewThreads: vi.fn(async () => {
        throw new Error('502 Bad Gateway');
      }),
    });
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    expect(outcome.status).toBe('run');
    if (outcome.status === 'run') {
      expect(outcome.plan.branding.advisories?.join(' ')).toMatch(/could not read the review conversations/);
    }
  });

  it('passes the missing-permission advisory through when the check state is unreadable', async () => {
    const adapter = roundAdapter({
      listChecks: vi.fn(async () => ({ available: false, reason: 'grant `checks: read`', checks: [] })),
    });
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event: reviewEvent(), cwd: '/nonexistent' });
    if (outcome.status === 'run') expect(outcome.plan.branding.advisories?.join(' ')).toContain('checks: read');
  });

  it('does not offer review as a candidate on a pull request crab\'d owns', async () => {
    const adapter = roundAdapter();
    const classify = vi.fn(async (_req: ClassifyRequest) => ({ mode: 'implement' }));
    const inline: ForgeEvent = {
      ...reviewEvent(),
      kind: 'pull_request_review_comment',
      action: 'created',
      review: undefined,
      comment: { id: 41, body: 'why did you do this?', author: 'lescher', createdAt: '' },
    };
    await prepareRun({ adapter, config: config(['MEMBER']), event: inline, cwd: '/nonexistent', classify });
    expect(classify).toHaveBeenCalledOnce();
    const req = classify.mock.calls[0]![0];
    expect(req.candidates.map((c) => c.name).sort()).toEqual(['implement', 'mention']);
    expect(req.subjectIsOwnPr).toBe(true);
  });

  it('leaves an ordinary pull request alone', async () => {
    const adapter = roundAdapter({
      getContext: vi.fn(async () => ({
        repo,
        pullRequest: { ...ownPr, body: 'a human wrote this', headRef: 'feat/theirs' },
        comments: [],
        changedFiles: [],
      })),
    });
    const event = { ...reviewEvent(), pullRequest: { ...ownPr, body: 'a human wrote this', headRef: 'feat/theirs' } };
    const outcome = await prepareRun({ adapter, config: config(['MEMBER']), event, cwd: '/nonexistent' });
    expect(outcome.status).toBe('skip');
    expect(adapter.listReviewThreads).not.toHaveBeenCalled();
  });
});

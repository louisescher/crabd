import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '@crabd/config';
import type {
  ForgeAdapter,
  ForgeContext,
  ForgeEvent,
  PullRequestRef,
  ReviewSubmission,
  ReviewThreadSummary,
  TrackingComment,
} from '../forge/types.ts';
import { registerBuiltinModes } from './builtins.ts';
import { getMode, listModes } from './registry.ts';
import { applyFindingGates, reviewMode, type ReviewFinding } from './review.ts';
import { commitWorkingChanges } from './shared.ts';
import { BranchMovedError } from '../forge/commit-guard.ts';
import { DEFAULT_BRANDING, PR_MARKER, renderResult, renderWorking } from '../report/tracking.ts';

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
    replyToReviewComment: vi.fn(async () => {}),
    postReview: vi.fn(async () => {}),
    listReviewThreads: vi.fn(async () => []),
    listReviews: vi.fn(async () => []),
    resolveReviewThread: vi.fn(async () => true),
    listChecks: vi.fn(async () => ({ available: true, checks: [] })),
    commitToBranch: vi.fn(async () => {}),
    openOrUpdatePR: vi.fn(async (): Promise<PullRequestRef> => ({ number: 2, url: 'http://pr/2' })),
    readOrgConfig: vi.fn(async () => undefined),
    checkRepoAccess: vi.fn(async () => 'ok' as const),
    ...overrides,
  };
}

const baseContext: ForgeContext = {
  repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
  pullRequest: {
    number: 5, title: 'Feature', body: 'body', author: 'dev', labels: [], state: 'open',
    headRef: 'feat', baseRef: 'main', headSha: 'sha', fromFork: false, isDraft: false,
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

/**
 * A conforming finding. Defaults are chosen to pass every gate — `confidence` above the default
 * floor of 7, and an empty evidence quote so the on-disk check is a no-op — so each test can
 * override exactly the one field it is about.
 */
function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    path: 'src/a.ts',
    line: 12,
    body: 'Guard against null.',
    severity: 'major',
    category: 'correctness',
    shortSummary: 'missing null guard',
    failureScenario: 'a request with no body reaches the handler and it throws on `.id`',
    evidence: { location: 'src/a.ts:12', quote: '' },
    confidence: 8,
    ...over,
  };
}

describe('review mode finalize', () => {
  it('posts a review with the verdict and inline findings', async () => {
    const adapter = fakeAdapter();
    const result = await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: {
        summary: 'Looks mostly good.',
        verdict: 'REQUEST_CHANGES',
        findings: [finding()],
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
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: { summary: 'Ship it.', verdict: 'APPROVE', findings: [] },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    expect(submission.event).toBe('COMMENT'); // never APPROVE/REQUEST_CHANGES
    expect(result.summary).toMatch(/Good to merge \(LGTM\)\./); // verdict still shown
  });

  it('folds findings outside the diff into the body instead of posting them inline', async () => {
    const adapter = fakeAdapter();
    // Diff touches only new-side lines 1-2 of src/a.ts; line 99 is outside any hunk.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');
    const result = await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: { ...baseContext, diff },
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: {
        summary: 'Review.',
        verdict: 'REQUEST_CHANGES',
        findings: [
          finding({ line: 2, body: 'In-diff finding.' }), // commentable
          finding({ line: 99, body: 'Out-of-diff finding.' }), // far outside any hunk
        ],
      },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    // Only the in-diff finding is anchored inline...
    expect(submission.comments).toHaveLength(1);
    expect(submission.comments?.[0]?.line).toBe(2);
    // ...and the out-of-diff one is preserved in the body, not dropped.
    expect(submission.body).toContain('src/a.ts:99');
    expect(submission.body).toContain('Out-of-diff finding.');
    // The suffix counts only what actually went inline.
    expect(result.summary).toMatch(/\(1 inline finding\)/);
  });

  it('renders the structured fields into the inline comment body', async () => {
    const adapter = fakeAdapter();
    await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: {
        summary: 'Review.',
        verdict: 'REQUEST_CHANGES',
        findings: [finding({ recommendation: 'Add an early return.' })],
      },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    const body = submission.comments?.[0]?.body ?? '';
    expect(body).toContain('**major**');
    expect(body).toContain('`correctness`');
    expect(body).toContain('missing null guard');
    expect(body).toContain('**Fails when:** a request with no body');
    expect(body).toContain('**Fix:** Add an early return.');
    expect(body).toContain('src/a.ts:12');
  });

  it('snaps a near-miss line onto a legal one and records the intended line', async () => {
    const adapter = fakeAdapter();
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+const b = 2;',
      '',
    ].join('\n');
    await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: { ...baseContext, diff },
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      // Commentable lines are 1-2; 4 is a near miss, well within tolerance.
      data: { summary: 'Review.', verdict: 'COMMENT', findings: [finding({ line: 4, severity: 'nit' })] },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    // Kept inline rather than demoted to body text, which is the whole point.
    expect(submission.comments).toHaveLength(1);
    expect(submission.comments?.[0]?.line).toBe(2);
    expect(submission.comments?.[0]?.body).toContain('(Refers to line 4.)');
  });

  it('does not approve while a blocking finding stands', async () => {
    const adapter = fakeAdapter();
    const result = await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: { summary: 'Fine.', verdict: 'APPROVE', findings: [finding({ severity: 'blocker' })] },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    expect(submission.event).toBe('REQUEST_CHANGES');
    expect(result.summary).toMatch(/Please address the findings before merging/);
  });

  it('still approves when only nits remain', async () => {
    const adapter = fakeAdapter();
    await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: { summary: 'Fine.', verdict: 'APPROVE', findings: [finding({ severity: 'nit' })] },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    expect(submission.event).toBe('APPROVE');
  });

  it('drops sub-threshold findings and reports only an aggregate', async () => {
    const adapter = fakeAdapter();
    await reviewMode.finalize({
      adapter,
      config: resolveConfig({ layers: {} }), // default floor is 7
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'review', explicit: true },
      cwd: '/tmp',
      baseline: new Map(),
      data: {
        summary: 'Review.',
        verdict: 'COMMENT',
        findings: [
          finding({ confidence: 8, body: 'kept finding' }),
          finding({ confidence: 4, body: 'SPECULATIVE GUESS' }),
          finding({ confidence: 2, body: 'ANOTHER GUESS' }),
        ],
      },
    });

    const [, submission] = (adapter.postReview as ReturnType<typeof vi.fn>).mock.calls[0] as [number, ReviewSubmission];
    expect(submission.comments).toHaveLength(1);
    expect(submission.body).toContain('2 low-confidence observations withheld');
    // The withheld findings' text must not leak anywhere in the review.
    expect(submission.body).not.toContain('SPECULATIVE GUESS');
    expect(submission.body).not.toContain('ANOTHER GUESS');
  });
});

describe('review mode validate', () => {
  const anchorable = new Map([['src/a.ts', new Set([1, 2, 3])]]);
  const ctx = { changedPaths: ['src/a.ts'], anchorable, cwd: '/tmp' };
  const output = (findings: ReviewFinding[]) => ({ summary: 's', verdict: 'COMMENT' as const, findings });

  it('passes a clean answer', () => {
    expect(reviewMode.validate?.(output([finding({ line: 2 })]), ctx)).toEqual({ ok: true });
  });

  it('passes a near miss, because finalize snaps it rather than losing it', () => {
    expect(reviewMode.validate?.(output([finding({ line: 6 })]), ctx)?.ok).toBe(true);
  });

  it('asks for a repair when a finding is stranded far outside every hunk', () => {
    const result = reviewMode.validate?.(output([finding({ line: 400, shortSummary: 'way off' })]), ctx);
    expect(result?.ok).toBe(false);
    if (result?.ok === false) {
      expect(result.repairPrompt).toContain('src/a.ts:400');
      expect(result.repairPrompt).toContain('way off');
      // The model is handed the legal lines, not just told it was wrong.
      expect(result.repairPrompt).toContain('anchorable lines in that file: 1, 2, 3');
      // And is told not to treat this as an invitation to review again.
      expect(result.repairPrompt).toContain('do not go looking for new problems');
    }
  });

  it('asks for a repair when a finding names a file outside the change', () => {
    const result = reviewMode.validate?.(output([finding({ path: 'src/elsewhere.ts', line: 2 })]), ctx);
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.repairPrompt).toContain('`src/elsewhere.ts`');
  });

  it('asks for a repair when a failure scenario is missing', () => {
    const result = reviewMode.validate?.(output([finding({ line: 2, failureScenario: '  ' })]), ctx);
    expect(result?.ok).toBe(false);
    if (result?.ok === false) expect(result.repairPrompt).toContain('empty `failureScenario`');
  });

  it('checks nothing it has no data for', () => {
    const empty = { changedPaths: [], anchorable: new Map<string, Set<number>>(), cwd: '/tmp' };
    expect(reviewMode.validate?.(output([finding({ path: 'anything.ts', line: 999 })]), empty)).toEqual({ ok: true });
  });

  it('is satisfied by an empty review', () => {
    expect(reviewMode.validate?.(output([]), ctx)).toEqual({ ok: true });
  });
});

describe('applyFindingGates', () => {
  const gate = (findings: ReviewFinding[], over: Partial<{ minConfidence: number; maxFindings: number }> = {}) =>
    applyFindingGates(findings, { cwd: '/tmp', minConfidence: 7, maxFindings: 10, ...over });

  it('drops findings under the confidence floor', () => {
    const { kept, dropped } = gate([finding({ confidence: 7 }), finding({ confidence: 6 })]);
    expect(kept).toHaveLength(1);
    expect(dropped.lowConfidence).toBe(1);
  });

  it('ranks most severe first, then most confident', () => {
    const { kept } = gate([
      finding({ severity: 'nit', shortSummary: 'n' }),
      finding({ severity: 'blocker', shortSummary: 'b' }),
      finding({ severity: 'major', confidence: 8, shortSummary: 'm8' }),
      finding({ severity: 'major', confidence: 10, shortSummary: 'm10' }),
    ]);
    expect(kept.map((f) => f.shortSummary)).toEqual(['b', 'm10', 'm8', 'n']);
  });

  it('caps the list after ranking, so the best findings survive', () => {
    const { kept, dropped } = gate(
      [finding({ severity: 'nit', shortSummary: 'n' }), finding({ severity: 'blocker', shortSummary: 'b' })],
      { maxFindings: 1 },
    );
    expect(kept.map((f) => f.shortSummary)).toEqual(['b']);
    expect(dropped.truncated).toBe(1);
  });

  describe('evidence quote verification', () => {
    let dir: string;

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'crabd-evidence-'));
      writeFileSync(join(dir, 'real.ts'), 'export function handle(req) {\n  return req.body.id;\n}\n');
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    const gateIn = (f: ReviewFinding) =>
      applyFindingGates([f], { cwd: dir, minConfidence: 7, maxFindings: 10 });

    it('discards a finding whose quote is absent from a file it could read', () => {
      const { kept, dropped } = gateIn(
        finding({ path: 'real.ts', evidence: { location: 'real.ts:2', quote: 'NOT_IN_THIS_FILE_AT_ALL' } }),
      );
      expect(kept).toHaveLength(0);
      expect(dropped.unevidenced).toBe(1);
    });

    it('keeps a finding whose quote really is in the file, ignoring whitespace differences', () => {
      const { kept } = gateIn(
        finding({ path: 'real.ts', evidence: { location: 'real.ts:2', quote: 'return    req.body.id;' } }),
      );
      expect(kept).toHaveLength(1);
    });

    it('falls back to the finding path when the evidence location names no readable file', () => {
      const { kept } = gateIn(
        finding({ path: 'real.ts', evidence: { location: 'somewhere-else.ts:9', quote: 'req.body.id' } }),
      );
      expect(kept).toHaveLength(1);
    });

    it('skips the check when the checkout is not the change, so the whole review survives', () => {
      const { kept, dropped } = applyFindingGates(
        [finding({ path: 'real.ts', evidence: { location: 'real.ts:2', quote: 'NOT_IN_THIS_FILE_AT_ALL' } })],
        { cwd: dir, minConfidence: 7, maxFindings: 10, verifyQuotes: false },
      );
      expect(kept).toHaveLength(1);
      expect(dropped.unevidenced).toBe(0);
    });
  });

  it('gives the benefit of the doubt when no cited file can be read', () => {
    // An unreadable file is not proof of a fabricated citation, so the finding survives.
    const { kept, dropped } = gate([
      finding({ path: 'gone.ts', evidence: { location: 'gone.ts:3', quote: 'something' } }),
    ]);
    expect(kept).toHaveLength(1);
    expect(dropped.unevidenced).toBe(0);
  });
});

/**
 * These cover the failure that motivated the gate: a bare `@crabd` on someone's pull request came
 * back as a commit pushed to their branch. `made_changes` is true throughout (the model did edit
 * files), so each test is about what finalize does with them.
 */
describe('mention mode finalize', () => {
  const data = { response: 'Here is what I found.', made_changes: true, branch: 'their-pr-branch' };

  // A real checkout with an uncommitted edit: the commit path reads `git status`, and a gate that
  // only passes because the tree looked clean would prove nothing.
  let dirty: string;
  beforeAll(() => {
    dirty = mkdtempSync(join(tmpdir(), 'crabd-mention-'));
    execFileSync('git', ['init', '-q'], { cwd: dirty });
    writeFileSync(join(dirty, 'edited.ts'), 'export const a = 1;\n');
  });
  afterAll(() => rmSync(dirty, { recursive: true, force: true }));

  const run = (over: { instruction?: string; write?: boolean } = {}) => {
    const adapter = fakeAdapter();
    const mode = getMode('mention')!;
    return mode
      .finalize({
        adapter,
        config: resolveConfig({
          layers: {
            repo: {
              permissions: { secret_scan: false, ...(over.write === undefined ? {} : { write: over.write }) },
            },
          },
        }),
        event: baseEvent,
        context: baseContext,
        trigger: {
          mode: 'mention',
          explicit: false,
          ...(over.instruction ? { userInstruction: over.instruction } : {}),
        },
        cwd: dirty,
        baseline: new Map(),
        data,
      })
      .then((result) => ({ result, adapter }));
  };

  it('does not commit for a bare mention that asked for nothing', async () => {
    const { result, adapter } = await run();
    expect(adapter.commitToBranch).not.toHaveBeenCalled();
    expect(result.summary).toContain('Here is what I found.');
    expect(result.summary).toMatch(/did not commit anything/);
    expect(result.summary).not.toContain('their-pr-branch');
  });

  it('commits when the mention actually asked for a change', async () => {
    const { result, adapter } = await run({ instruction: 'fix the null check in parse()' });
    expect(adapter.commitToBranch).toHaveBeenCalledTimes(1);
    expect(result.summary).toContain('Committed changes to `their-pr-branch`');
  });

  it('does not commit when writes are off, however explicit the request', async () => {
    const { result, adapter } = await run({ instruction: 'fix the null check', write: false });
    expect(adapter.commitToBranch).not.toHaveBeenCalled();
    expect(result.summary).toMatch(/writes are turned off/);
  });

  it('still answers when it declines to commit', async () => {
    const { result } = await run({ write: false });
    expect(result.summary.startsWith('Here is what I found.')).toBe(true);
  });

  it('leaves an answer with no edits alone', async () => {
    const adapter = fakeAdapter();
    const result = await getMode('mention')!.finalize({
      adapter,
      config: resolveConfig({ layers: {} }),
      event: baseEvent,
      context: baseContext,
      trigger: { mode: 'mention', explicit: false },
      cwd: '/tmp',
      baseline: new Map(),
      data: { response: 'It parses the header.', made_changes: false },
    });
    expect(adapter.commitToBranch).not.toHaveBeenCalled();
    expect(result.summary).toBe('It parses the header.');
  });
});

describe('implement mode', () => {
  let dirty: string;
  beforeAll(() => {
    dirty = mkdtempSync(join(tmpdir(), 'crabd-implement-'));
    execFileSync('git', ['init', '-q'], { cwd: dirty });
    writeFileSync(join(dirty, 'edited.ts'), 'export const a = 1;\n');
  });
  afterAll(() => rmSync(dirty, { recursive: true, force: true }));

  const thread = (over: Partial<ReviewThreadSummary> = {}): ReviewThreadSummary => ({
    id: 'T1',
    rootCommentId: 101,
    path: 'src/a.ts',
    line: 12,
    isResolved: false,
    rootIsCrabd: false,
    comments: [{ id: 101, author: 'dev', body: 'this leaks', createdAt: '' }],
    ...over,
  });

  const config = (over: Record<string, unknown> = {}) =>
    resolveConfig({ layers: { repo: { permissions: { secret_scan: false }, ...over } } });

  const roundContext = (over: Partial<ForgeContext> = {}): ForgeContext => ({
    ...baseContext,
    reviewThreads: [thread()],
    ...over,
  });

  const roundData = (over: Partial<Record<string, unknown>> = {}) => ({
    kind: 'round' as const,
    summary: 'Fixed the leak.',
    commit_message: 'fix(a): close the handle',
    threads: [{ thread_id: 'T1', outcome: 'fixed' as const, reply: 'Closed it in `finally`.' }],
    ...over,
  });

  const runRound = (
    over: {
      context?: ForgeContext;
      data?: Record<string, unknown>;
      kind?: 'github' | 'forgejo';
      config?: Record<string, unknown>;
      cwd?: string;
      adapterOverrides?: Partial<ForgeAdapter>;
    } = {},
  ) => {
    const adapter = fakeAdapter({
      ...(over.kind === 'forgejo' ? { kind: 'forgejo' as const } : {}),
      ...(over.adapterOverrides ?? {}),
    });
    return getMode('implement')!
      .finalize({
        adapter,
        config: config(over.config),
        event: { ...baseEvent, kind: 'pull_request_review', action: 'submitted' },
        context: over.context ?? roundContext(),
        trigger: { mode: 'implement', explicit: true },
        cwd: over.cwd ?? dirty,
        baseline: new Map(),
        data: over.data ?? roundData(),
      })
      .then((result) => ({ result, adapter }));
  };

  describe('round phase', () => {
    it('commits to the pull request head branch with its own base', async () => {
      const { adapter } = await runRound();
      expect(adapter.commitToBranch).toHaveBeenCalledWith(
        expect.objectContaining({ branch: 'feat', baseBranch: 'main', expectedParentSha: 'sha', message: 'fix(a): close the handle' }),
      );
    });

    it('never opens a pull request, and never retitles one', async () => {
      const { adapter } = await runRound();
      expect(adapter.openOrUpdatePR).not.toHaveBeenCalled();
    });

    it('replies in the thread and resolves what it fixed', async () => {
      const { adapter, result } = await runRound();
      expect(adapter.replyToReviewComment).toHaveBeenCalledWith(5, 101, expect.stringContaining('Closed it in `finally`.'));
      expect(adapter.resolveReviewThread).toHaveBeenCalledWith('T1');
      expect(result.handledThreadReplies).toBe(true);
      expect(result.trackingComment).toContain('1 conversation answered, 1 resolved');
    });

    it('does not resolve a thread it declined', async () => {
      const { adapter } = await runRound({
        data: roundData({ threads: [{ thread_id: 'T1', outcome: 'declined', reply: 'The caller already guards this.' }] }),
      });
      expect(adapter.replyToReviewComment).toHaveBeenCalledTimes(1);
      expect(adapter.resolveReviewThread).not.toHaveBeenCalled();
    });

    it('leaves threads alone when resolve_threads is off', async () => {
      const { adapter } = await runRound({ config: { implement: { rounds: { resolve_threads: false } } } });
      expect(adapter.replyToReviewComment).toHaveBeenCalledTimes(1);
      expect(adapter.resolveReviewThread).not.toHaveBeenCalled();
    });

    it('on a forge without threading, puts the answers in the comment that actually gets posted', async () => {
      const { adapter, result } = await runRound({ kind: 'forgejo' });
      expect(adapter.replyToReviewComment).not.toHaveBeenCalled();
      expect(adapter.resolveReviewThread).not.toHaveBeenCalled();
      // `trackingComment` is what `finalizeRun` posts; `summary` only reaches the CI output.
      expect(result.trackingComment).toContain('`src/a.ts:12`');
      expect(result.trackingComment).toContain('**fixed**');
      expect(result.trackingComment).toMatch(/no API for resolving/);
      expect(result.handledThreadReplies).toBe(true);
    });

    it('keeps the tracking comment short when the answers went into the conversations', async () => {
      const { result } = await runRound();
      expect(result.trackingComment).not.toContain('**fixed**');
      expect(result.trackingComment).toContain('1 conversation answered');
    });

    it('reports a reply failure instead of claiming the conversations were answered', async () => {
      const { result } = await runRound({
        adapterOverrides: {
          replyToReviewComment: vi.fn(async () => {
            throw new Error('403 Resource not accessible');
          }),
        },
      });
      expect(result.trackingComment).toMatch(/could not reply on `src\/a\.ts:12`/);
      expect(result.trackingComment).toContain('403');
    });

    it('refuses without failing the run when the branch moved under it', async () => {
      const { result } = await runRound({
        adapterOverrides: {
          commitToBranch: vi.fn(async () => {
            throw new BranchMovedError('crabd: refusing to commit: `feat` moved from aaaaaaaa to bbbbbbbb during this run.');
          }),
        },
      });
      expect(result.summary).toMatch(/moved from aaaaaaaa to bbbbbbbb/);
      expect(result.summary).toMatch(/Ask again/);
      expect(result.trackingComment).toMatch(/moved from/);
    });

    it('refuses when the pull request reports no head commit', async () => {
      const context = roundContext({ pullRequest: { ...baseContext.pullRequest!, headSha: '' } });
      const { adapter, result } = await runRound({ context });
      expect(adapter.commitToBranch).not.toHaveBeenCalled();
      expect(result.summary).toMatch(/no head commit/);
    });

    it('resolves an already-fixed conversation even though it committed nothing', async () => {
      const clean = mkdtempSync(join(tmpdir(), 'crabd-clean-resolve-'));
      execFileSync('git', ['init', '-q'], { cwd: clean });
      const { adapter } = await runRound({
        cwd: clean,
        data: roundData({ threads: [{ thread_id: 'T1', outcome: 'already-fixed', reply: 'Handled in abc1234.' }] }),
      });
      expect(adapter.commitToBranch).not.toHaveBeenCalled();
      expect(adapter.resolveReviewThread).toHaveBeenCalledWith('T1');
      rmSync(clean, { recursive: true, force: true });
    });

    it('never touches the pull request description, even when the model supplies one', async () => {
      const { adapter } = await runRound({ data: roundData({ pr_body: 'a rewritten description' }) });
      expect(adapter.openOrUpdatePR).not.toHaveBeenCalled();
    });

    it('refuses to commit to a fork, and says what it would have changed', async () => {
      const context = roundContext({
        pullRequest: { ...baseContext.pullRequest!, fromFork: true, headRepoSlug: 'someone/app' },
      });
      const { adapter, result } = await runRound({ context });
      expect(adapter.commitToBranch).not.toHaveBeenCalled();
      expect(adapter.replyToReviewComment).not.toHaveBeenCalled();
      expect(result.summary).toContain('someone/app');
      expect(result.summary).toContain('edited.ts');
    });

    it('refuses to commit from a checkout that is not the pull request head', async () => {
      const { adapter, result } = await runRound({ context: roundContext() , data: roundData() });
      expect(adapter.commitToBranch).toHaveBeenCalled();
      const stale = await getMode('implement')!.finalize({
        adapter: fakeAdapter(),
        config: config(),
        event: { ...baseEvent, kind: 'pull_request_review', action: 'submitted' },
        context: roundContext(),
        trigger: { mode: 'implement', explicit: true },
        cwd: dirty,
        baseline: new Map(),
        workspace: { status: '', recentCommits: [], containsPrHead: false },
        data: roundData(),
      });
      expect(stale.summary).toMatch(/not this pull request's head commit/);
      expect(result.summary).toBe('Fixed the leak.');
    });

    it('still answers the threads when there was nothing to commit', async () => {
      const clean = mkdtempSync(join(tmpdir(), 'crabd-clean-'));
      execFileSync('git', ['init', '-q'], { cwd: clean });
      const { adapter, result } = await runRound({
        cwd: clean,
        data: roundData({
          threads: [{ thread_id: 'T1', outcome: 'answered', reply: 'It is handled by the router.' }],
          no_changes_reason: 'The thread was a question.',
        }),
      });
      expect(adapter.commitToBranch).not.toHaveBeenCalled();
      expect(adapter.replyToReviewComment).toHaveBeenCalledTimes(1);
      expect(result.summary).toMatch(/nothing was committed/);
      rmSync(clean, { recursive: true, force: true });
    });

    it('discloses a failed verification without blocking the commit', async () => {
      const { adapter, result } = await runRound({
        data: roundData({
          verification: [
            { command: 'pnpm test', status: 'failed', detail: '1 failing' },
            { command: 'pnpm typecheck', status: 'passed' },
          ],
        }),
      });
      expect(adapter.commitToBranch).toHaveBeenCalledTimes(1);
      expect(result.summary).toContain('❌ `pnpm test`');
      expect(result.summary).toContain('✅ `pnpm typecheck`');
      expect(result.summary).toMatch(/does not block the commit/);
    });

    it('ignores an answer for a thread that is not open', async () => {
      const { adapter } = await runRound({
        data: roundData({ threads: [{ thread_id: 'nope', outcome: 'fixed', reply: 'done' }] }),
      });
      expect(adapter.replyToReviewComment).not.toHaveBeenCalled();
    });
  });

  describe('issue phase', () => {
    const runIssue = (over: Record<string, unknown> = {}) => {
      const adapter = fakeAdapter();
      return getMode('implement')!
        .finalize({
          adapter,
          config: config(),
          event: { ...baseEvent, kind: 'issues', action: 'assigned', pullRequest: undefined },
          context: { ...baseContext, pullRequest: undefined, issue: { number: 9, title: 'T', body: 'B', author: 'dev', labels: [], state: 'open' } },
          trigger: { mode: 'implement', explicit: true },
          cwd: dirty,
          baseline: new Map(),
          data: { kind: 'issue', summary: 'Added it.', pr_title: 'feat: add it', pr_body: 'Closes #9', branch: 'my-branch', ...over },
        })
        .then((result) => ({ result, adapter }));
    };

    it('forces the branch prefix and marks the pull request as its own', async () => {
      const { adapter } = await runIssue();
      expect(adapter.commitToBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'crabd/my-branch' }));
      expect(adapter.openOrUpdatePR).toHaveBeenCalledWith(
        expect.objectContaining({ headBranch: 'crabd/my-branch', body: expect.stringContaining(PR_MARKER) }),
      );
    });

    it('keeps a branch that already carries the prefix', async () => {
      const { adapter } = await runIssue({ branch: 'crabd/implement-9' });
      expect(adapter.commitToBranch).toHaveBeenCalledWith(expect.objectContaining({ branch: 'crabd/implement-9' }));
    });
  });

  describe('validate', () => {
    const validate = (data: Record<string, unknown>, ctx: Record<string, unknown> = {}) =>
      getMode('implement')!.validate!(data, {
        changedPaths: [],
        anchorable: new Map(),
        cwd: '/tmp',
        ...ctx,
      });

    it('accepts a well-formed round', () => {
      expect(validate(roundData(), { subjectKind: 'pull_request', threadIds: ['T1'] })).toEqual({ ok: true });
    });

    it('rejects the wrong phase, naming the right one', () => {
      const result = validate({ kind: 'issue', summary: 's', pr_title: 't', pr_body: 'b', branch: 'x' }, { subjectKind: 'pull_request' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('kind: "round"');
    });

    it('rejects an unknown thread id and lists the legal ones', () => {
      const result = validate(roundData({ threads: [{ thread_id: 'T9', outcome: 'fixed', reply: 'r' }] }), {
        subjectKind: 'pull_request',
        threadIds: ['T1', 'T2'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('T1, T2');
    });

    it('rejects a round that left a thread unanswered', () => {
      const result = validate(roundData(), { subjectKind: 'pull_request', threadIds: ['T1', 'T2'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('T2');
    });

    it('rejects a duplicate thread answer', () => {
      const result = validate(
        roundData({
          threads: [
            { thread_id: 'T1', outcome: 'fixed', reply: 'a' },
            { thread_id: 'T1', outcome: 'declined', reply: 'b' },
          ],
        }),
        { subjectKind: 'pull_request', threadIds: ['T1'] },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toMatch(/appears twice/);
    });

    it('rejects a round with no commit message', () => {
      const result = validate(roundData({ commit_message: '' }), { subjectKind: 'pull_request', threadIds: ['T1'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('commit_message');
    });

    it('rejects an unreported verification command', () => {
      const result = validate(roundData(), {
        subjectKind: 'pull_request',
        threadIds: ['T1'],
        verifyCommands: ['pnpm test'],
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('pnpm test');
    });

    it('requires the pull request fields on the issue phase', () => {
      const result = validate({ kind: 'issue', summary: 's' }, { subjectKind: 'issue' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.repairPrompt).toContain('pr_title');
    });
  });
});

describe('commitWorkingChanges write gate', () => {
  it('throws rather than committing when writes are disabled', async () => {
    await expect(
      commitWorkingChanges({
        adapter: fakeAdapter(),
        cwd: '/tmp',
        baseline: new Map(),
        branch: 'any',
        message: 'any',
        writesAllowed: false,
      }),
    ).rejects.toThrow(/writes are disabled/);
  });
});

describe('tracking comment rendering', () => {
  it('renders a working comment for each mode', () => {
    expect(renderWorking(DEFAULT_BRANDING, 'review')).toMatch(/reviewing this pull request/);
    expect(renderWorking(DEFAULT_BRANDING, 'mention')).toMatch(/crab'd/);
  });
  it('renders a result with an optional PR link', () => {
    const body = renderResult(DEFAULT_BRANDING, { mode: 'implement', summary: 'Done', prUrl: 'http://pr/2' });
    expect(body).toMatch(/Done/);
    expect(body).toMatch(/http:\/\/pr\/2/);
  });
});

import { describe, expect, it } from 'vitest';
import { detectTrigger } from './detect.ts';
import { parseGitHubEvent } from './parse-github.ts';
import type { ForgeEvent, ForgePullRequest, ForgeReview } from '../forge/types.ts';
import { PR_MARKER, REPLY_MARKER } from '../report/tracking.ts';

const ALL_MODES = new Set(['mention', 'review', 'implement']);

function commentEvent(body: string): ForgeEvent {
  return {
    forge: 'github',
    kind: 'issue_comment',
    action: 'created',
    repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
    actor: { login: 'dev', association: 'MEMBER', isBot: false },
    issue: { number: 7, title: 'T', body: 'B', author: 'dev', labels: [], state: 'open' },
    comment: { id: 1, body, author: 'dev', createdAt: '' },
    raw: {},
  };
}

describe('detectTrigger — comments', () => {
  it('plain mention → mention mode with trailing instruction', () => {
    const t = detectTrigger(commentEvent('@crabd please fix the flaky test'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t).toEqual({ mode: 'mention', explicit: false, userInstruction: 'please fix the flaky test' });
  });

  it('mention with review keyword → review mode, instruction is the remainder', () => {
    const t = detectTrigger(commentEvent('@crabd review focus on the migration'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t).toEqual({ mode: 'review', explicit: true, userInstruction: 'focus on the migration' });
  });

  it('mention with implement keyword and no extra text', () => {
    const t = detectTrigger(commentEvent('@crabd implement'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t).toEqual({ mode: 'implement', explicit: true, userInstruction: undefined });
  });

  it('matches a custom mode name as the keyword', () => {
    const t = detectTrigger(commentEvent('@crabd triage this please'), {
      triggerPhrase: '@crabd',
      enabledModes: new Set(['mention', 'triage']),
    });
    expect(t).toEqual({ mode: 'triage', explicit: true, userInstruction: 'this please' });
  });

  it('an unknown keyword falls back to mention (not explicit → classifiable) with the full instruction', () => {
    const t = detectTrigger(commentEvent('@crabd fix the flaky test'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t).toEqual({ mode: 'mention', explicit: false, userInstruction: 'fix the flaky test' });
  });

  it('marks a bare mention as not explicit and a keyword-selected mode as explicit', () => {
    const bare = detectTrigger(commentEvent('@crabd take another look please'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(bare?.explicit).toBe(false);
    const keyword = detectTrigger(commentEvent('@crabd review'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(keyword?.explicit).toBe(true);
  });

  it('is case-insensitive on the phrase', () => {
    const t = detectTrigger(commentEvent('Hey @CRABD what is this?'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t?.mode).toBe('mention');
    expect(t?.userInstruction).toBe('what is this?');
  });

  it('no phrase → no trigger', () => {
    const t = detectTrigger(commentEvent('just a normal comment'), {
      triggerPhrase: '@crabd',
      enabledModes: ALL_MODES,
    });
    expect(t).toBeNull();
  });

  it('an explicitly-named but disabled mode yields no trigger', () => {
    const t = detectTrigger(commentEvent('@crabd review this'), {
      triggerPhrase: '@crabd',
      knownModes: ALL_MODES,
      enabledModes: new Set(['mention']),
    });
    expect(t).toBeNull();
  });

  it('a deleted comment never triggers, even carrying the trigger phrase in its body', () => {
    const deleted: ForgeEvent = { ...commentEvent('@crabd please fix the flaky test'), action: 'deleted' };
    expect(detectTrigger(deleted, { triggerPhrase: '@crabd', enabledModes: ALL_MODES })).toBeNull();
  });
});

describe('detectTrigger — non-comment events', () => {
  const prEvent = (action: string, isDraft = false): ForgeEvent => ({
    forge: 'github',
    kind: 'pull_request',
    action,
    repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
    actor: { login: 'dev', association: 'MEMBER', isBot: false },
    pullRequest: {
      number: 3, title: 'T', body: 'B', author: 'dev', labels: [], state: 'open',
      headRef: 'feat', baseRef: 'main', headSha: 'abc', fromFork: false, isDraft,
    },
    raw: {},
  });

  it('PR opened → review', () => {
    expect(detectTrigger(prEvent('opened'), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })?.mode).toBe('review');
  });
  it('PR reopened / ready_for_review → review', () => {
    expect(detectTrigger(prEvent('reopened'), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })?.mode).toBe('review');
    expect(detectTrigger(prEvent('ready_for_review'), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })?.mode).toBe('review');
  });
  it('draft PR opened / reopened → no trigger', () => {
    expect(detectTrigger(prEvent('opened', true), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })).toBeNull();
    expect(detectTrigger(prEvent('reopened', true), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })).toBeNull();
  });
  it('PR synchronize (a push) → no trigger', () => {
    expect(detectTrigger(prEvent('synchronize'), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })).toBeNull();
  });
  it('PR closed → no trigger', () => {
    expect(detectTrigger(prEvent('closed'), { triggerPhrase: '@crabd', enabledModes: ALL_MODES })).toBeNull();
  });
  it('issue assigned → implement', () => {
    const ev: ForgeEvent = {
      forge: 'github', kind: 'issues', action: 'assigned',
      repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
      actor: { login: 'dev', association: 'MEMBER', isBot: false },
      issue: { number: 9, title: 'T', body: 'B', author: 'dev', labels: [], state: 'open' },
      raw: {},
    };
    expect(detectTrigger(ev, { triggerPhrase: '@crabd', enabledModes: ALL_MODES })?.mode).toBe('implement');
  });
});

describe('detectTrigger: feedback rounds', () => {
  const ownPr = (overrides: Partial<ForgePullRequest> = {}): ForgePullRequest => ({
    number: 4, title: 'T', body: `B\n\n${PR_MARKER}`, author: 'crabd', labels: [], state: 'open',
    headRef: 'crabd/implement-3', baseRef: 'main', headSha: 'abc', fromFork: false, isDraft: false,
    ...overrides,
  });

  const reviewEvent = (overrides: Partial<ForgeEvent> = {}, review?: Partial<ForgeReview>): ForgeEvent => ({
    forge: 'github',
    kind: 'pull_request_review',
    action: 'submitted',
    repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
    actor: { login: 'dev', association: 'MEMBER', isBot: false },
    pullRequest: ownPr(),
    review: { id: 50, state: 'changes_requested', body: 'needs work', author: 'dev', submittedAt: '', ...review },
    comment: { id: 50, body: review?.body ?? 'needs work', author: 'dev', createdAt: '' },
    raw: {},
    ...overrides,
  });

  const inlineEvent = (overrides: Partial<ForgeEvent> = {}): ForgeEvent => ({
    forge: 'github',
    kind: 'pull_request_review_comment',
    action: 'created',
    repo: { owner: 'acme', name: 'app', slug: 'acme/app', defaultBranch: 'main', isPrivate: true },
    actor: { login: 'dev', association: 'MEMBER', isBot: false },
    pullRequest: ownPr(),
    comment: { id: 12, body: 'this is wrong', author: 'dev', createdAt: '' },
    raw: {},
    ...overrides,
  });

  const opts = { triggerPhrase: '@crabd', enabledModes: ALL_MODES };

  it('submitted review requesting changes on its own PR → implement, explicitly', () => {
    expect(detectTrigger(reviewEvent(), opts)).toEqual({ mode: 'implement', explicit: true });
  });

  it('a comment-only review with a body → implement', () => {
    expect(detectTrigger(reviewEvent({}, { state: 'commented', body: 'one thought' }), opts)?.mode).toBe(
      'implement',
    );
  });

  it('an approval with nothing to act on → no trigger', () => {
    expect(detectTrigger(reviewEvent({}, { state: 'approved', body: '' }), opts)).toBeNull();
  });

  it('an empty comment-only review → no trigger', () => {
    expect(detectTrigger(reviewEvent({}, { state: 'commented', body: '' }), opts)).toBeNull();
  });

  it('a review on someone else\'s PR → no trigger', () => {
    const event = reviewEvent({ pullRequest: ownPr({ body: 'B', headRef: 'feat/mine' }) });
    expect(detectTrigger(event, opts)).toBeNull();
  });

  it('recognizes its own PR by the branch prefix when the marker is gone', () => {
    const event = reviewEvent({ pullRequest: ownPr({ body: 'B' }) });
    expect(detectTrigger(event, opts)?.mode).toBe('implement');
  });

  it('an inline comment on its own PR → implement, left to the classifier', () => {
    expect(detectTrigger(inlineEvent(), opts)).toEqual({ mode: 'implement', explicit: false });
  });

  it('ignores its own text, so a reply cannot loop', () => {
    const event = inlineEvent({ comment: { id: 13, body: `done\n\n${REPLY_MARKER}`, author: 'crabd', createdAt: '' } });
    expect(detectTrigger(event, opts)).toBeNull();
  });

  it('a draft PR is left alone', () => {
    expect(detectTrigger(reviewEvent({ pullRequest: ownPr({ isDraft: true }) }), opts)).toBeNull();
  });

  it('rounds off → no trigger', () => {
    expect(detectTrigger(reviewEvent(), { ...opts, implementRounds: false })).toBeNull();
  });

  it('implement disabled → no trigger', () => {
    expect(detectTrigger(reviewEvent(), { ...opts, enabledModes: new Set(['mention', 'review']) })).toBeNull();
  });

  it('a trigger phrase in a review body still selects a keyword mode', () => {
    const event = reviewEvent({}, { body: '@crabd review this again' });
    expect(detectTrigger(event, opts)).toEqual({ mode: 'review', explicit: true, userInstruction: 'this again' });
  });

  it('a dismissed or edited review is not a round', () => {
    expect(detectTrigger(reviewEvent({ action: 'edited' }), opts)).toBeNull();
    expect(detectTrigger(reviewEvent({ action: 'dismissed' }), opts)).toBeNull();
  });
});

describe('parseGitHubEvent', () => {
  it('normalizes an issue_comment on a PR', () => {
    const ev = parseGitHubEvent('issue_comment', {
      action: 'created',
      repository: { name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main', private: true },
      sender: { login: 'dev', type: 'User' },
      comment: { id: 42, body: '@crabd hi', user: { login: 'dev' }, author_association: 'COLLABORATOR', created_at: 'now' },
      issue: { number: 5, title: 'Bug', body: 'broken', user: { login: 'reporter' }, pull_request: { url: 'x' } },
    });
    expect(ev?.kind).toBe('issue_comment');
    expect(ev?.actor.association).toBe('COLLABORATOR');
    expect(ev?.comment?.body).toBe('@crabd hi');
    expect(ev?.issue?.number).toBe(5);
    expect(ev?.isPullRequest).toBe(true);
  });

  it('flags bot senders', () => {
    const ev = parseGitHubEvent('issues', {
      action: 'opened',
      repository: { name: 'app', owner: { login: 'acme' } },
      sender: { login: 'dependabot[bot]', type: 'Bot' },
      issue: { number: 1, title: 'T', user: { login: 'dependabot[bot]' } },
    });
    expect(ev?.actor.isBot).toBe(true);
  });

  it('returns null for unhandled events', () => {
    expect(parseGitHubEvent('push', {})).toBeNull();
  });

  it('throws when repository owner/name is missing', () => {
    expect(() => parseGitHubEvent('issues', { action: 'opened', issue: {} })).toThrow(/repository/);
  });

  describe('workflow_call (Forgejo reusable workflows)', () => {
    const repository = { name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main' };

    it('recovers pull_request from the payload', () => {
      const ev = parseGitHubEvent('workflow_call', {
        action: 'opened',
        repository,
        sender: { login: 'dev', type: 'User' },
        pull_request: { number: 7, title: 'Add divide', head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } },
      }, 'forgejo');
      expect(ev?.kind).toBe('pull_request');
      expect(ev?.action).toBe('opened');
      expect(ev?.pullRequest?.number).toBe(7);
    });

    it('recovers issue_comment on a PR from the payload', () => {
      const ev = parseGitHubEvent('workflow_call', {
        action: 'created',
        repository,
        sender: { login: 'dev', type: 'User' },
        comment: { id: 9, body: '@crabd review', user: { login: 'dev' } },
        issue: { number: 5, title: 'Bug', pull_request: { url: 'x' } },
      }, 'forgejo');
      expect(ev?.kind).toBe('issue_comment');
      expect(ev?.isPullRequest).toBe(true);
      expect(ev?.comment?.body).toBe('@crabd review');
    });

    it('recovers pull_request_review_comment from the payload', () => {
      const ev = parseGitHubEvent('workflow_call', {
        action: 'created',
        repository,
        sender: { login: 'dev', type: 'User' },
        comment: { id: 9, body: '@crabd this line', user: { login: 'dev' } },
        pull_request: { number: 7, title: 'Add divide', head: { ref: 'feat', sha: 'abc' }, base: { ref: 'main' } },
      }, 'forgejo');
      expect(ev?.kind).toBe('pull_request_review_comment');
    });

    it('recovers issues from the payload', () => {
      const ev = parseGitHubEvent('workflow_call', {
        action: 'labeled',
        repository,
        sender: { login: 'dev', type: 'User' },
        issue: { number: 5, title: 'Bug', labels: [{ name: 'crabd' }] },
      }, 'forgejo');
      expect(ev?.kind).toBe('issues');
    });

    it('stays null when the payload matches no handled event', () => {
      expect(parseGitHubEvent('workflow_call', {
        repository,
        sender: { login: 'dev', type: 'User' },
        ref: 'refs/heads/main',
        commits: [{ id: 'abc' }],
      }, 'forgejo')).toBeNull();
    });

    it('does not infer for other unhandled event names', () => {
      expect(parseGitHubEvent('push', { repository, pull_request: { number: 7 } })).toBeNull();
    });

    it('infers pull_request_review before pull_request', () => {
      const ev = parseGitHubEvent('workflow_call', {
        repository,
        sender: { login: 'dev', type: 'User' },
        action: 'submitted',
        pull_request: { number: 4, head: { ref: 'crabd/x', sha: 'abc' }, base: { ref: 'main' } },
        review: { id: 90, state: 'CHANGES_REQUESTED', body: 'no', user: { login: 'dev' } },
      }, 'forgejo');
      expect(ev?.kind).toBe('pull_request_review');
    });
  });

  describe('pull_request_review', () => {
    const repository = { name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main' };

    it('normalizes the review and mirrors it as the triggering comment', () => {
      const ev = parseGitHubEvent('pull_request_review', {
        repository,
        action: 'submitted',
        sender: { login: 'dev', type: 'User' },
        pull_request: { number: 4, title: 'T', head: { ref: 'crabd/x', sha: 'abc' }, base: { ref: 'main' } },
        review: { id: 90, state: 'CHANGES_REQUESTED', body: 'needs work', user: { login: 'dev' }, submitted_at: '2026-01-01T00:00:00Z' },
      });
      expect(ev?.kind).toBe('pull_request_review');
      expect(ev?.review).toEqual({
        id: 90,
        state: 'changes_requested',
        body: 'needs work',
        author: 'dev',
        submittedAt: '2026-01-01T00:00:00Z',
      });
      expect(ev?.comment).toEqual({ id: 90, body: 'needs work', author: 'dev', createdAt: '2026-01-01T00:00:00Z' });
    });

    it('maps Forgejo\'s rejected state onto changes_requested', () => {
      const ev = parseGitHubEvent('pull_request_review', {
        repository,
        action: 'submitted',
        sender: { login: 'dev', type: 'User' },
        pull_request: { number: 4, head: { ref: 'crabd/x' }, base: { ref: 'main' } },
        review: { id: 1, state: 'REJECTED', body: 'no' },
      }, 'forgejo');
      expect(ev?.review?.state).toBe('changes_requested');
    });
  });

  describe('fromFork', () => {
    const repository = { name: 'app', full_name: 'acme/app', owner: { login: 'acme' }, default_branch: 'main' };

    it('compares head and base repositories rather than trusting the fork flag', () => {
      const sameRepo = parseGitHubEvent('pull_request', {
        repository,
        action: 'opened',
        sender: { login: 'dev', type: 'User' },
        pull_request: {
          number: 4,
          head: { ref: 'feat', sha: 'abc', repo: { fork: true, full_name: 'acme/app' } },
          base: { ref: 'main' },
        },
      });
      expect(sameRepo?.pullRequest?.fromFork).toBe(false);
      expect(sameRepo?.pullRequest?.headRepoSlug).toBe('acme/app');

      const otherRepo = parseGitHubEvent('pull_request', {
        repository,
        action: 'opened',
        sender: { login: 'dev', type: 'User' },
        pull_request: {
          number: 4,
          head: { ref: 'feat', sha: 'abc', repo: { fork: false, full_name: 'someone/app' } },
          base: { ref: 'main' },
        },
      });
      expect(otherRepo?.pullRequest?.fromFork).toBe(true);
    });

    it('falls back to the fork flag when the head repository is unknown', () => {
      const ev = parseGitHubEvent('pull_request', {
        repository,
        action: 'opened',
        sender: { login: 'dev', type: 'User' },
        pull_request: { number: 4, head: { ref: 'feat', sha: 'abc', repo: { fork: true } }, base: { ref: 'main' } },
      });
      expect(ev?.pullRequest?.fromFork).toBe(true);
    });
  });
});

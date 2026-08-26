import { describe, expect, it } from 'vitest';
import { detectTrigger } from './detect.ts';
import { parseGitHubEvent } from './parse-github.ts';
import type { ForgeEvent } from '../forge/types.ts';

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
  });
});

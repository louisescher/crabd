import type { ResolvedConfig } from '@crabd/config';
import { describe, expect, it } from 'vitest';
import type { ForgeChangedFile, ForgeContext, ForgeEvent, ForgeRepo } from '../forge/types.ts';
import { assemblePrompt, compressDiff } from './assemble.ts';
import type { ProjectContext } from './project.ts';

const repo: ForgeRepo = {
  owner: 'acme',
  name: 'app',
  slug: 'acme/app',
  defaultBranch: 'main',
  isPrivate: true,
};

/**
 * A minimal resolved config for prompt tests. `context` is always present because `assemblePrompt`
 * reads `config.context.fullDiff`; pass overrides to vary a single field per test.
 */
function makeConfig(overrides: Record<string, unknown> = {}): ResolvedConfig {
  return {
    prompt: { instructions: '' },
    modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
    review: { commentOnly: false, strictness: 2 },
    context: { instructionFiles: true, skills: true, fullDiff: false },
    ...overrides,
  } as unknown as ResolvedConfig;
}

const config = makeConfig();

const context: ForgeContext = { repo, comments: [], changedFiles: [] };

const event = {
  forge: 'github',
  kind: 'issue_comment',
  action: 'created',
  repo,
  actor: { login: 'dev', association: 'OWNER', isBot: false },
  raw: {},
} as ForgeEvent;

function assemble(project?: ProjectContext): string {
  return assemblePrompt({ mode: 'mention', config, context, event, trigger: { mode: 'mention', explicit: true }, project }).instructions;
}

describe('assemblePrompt — project context', () => {
  it('omits project sections when there is no project context', () => {
    const instructions = assemble();
    expect(instructions).toContain("You are crab'd");
    expect(instructions).not.toContain('## Project instructions');
    expect(instructions).not.toContain('## Available skills');
  });

  it('appends instruction files after the base prompt', () => {
    const instructions = assemble({ instructions: 'Use tabs.', skills: [] });
    expect(instructions).toContain('## Project instructions');
    expect(instructions).toContain('Use tabs.');
    // Base prompt stays first so crab'd's own rules outrank repo-controlled text.
    expect(instructions.indexOf("You are crab'd")).toBeLessThan(instructions.indexOf('## Project instructions'));
  });

  it('renders a skills manifest with name, description, and path', () => {
    const instructions = assemble({
      skills: [{ name: 'run-tests', description: 'Use to run the suite.', path: '.claude/skills/run-tests/SKILL.md' }],
    });
    expect(instructions).toContain('## Available skills');
    expect(instructions).toContain('**run-tests** — Use to run the suite. (`.claude/skills/run-tests/SKILL.md`)');
  });
});

describe('assemblePrompt — operating-environment note', () => {
  it('tells the agent it works in a single, scoped checkout by default', () => {
    const instructions = assemble();
    expect(instructions).toContain('single checked-out repository');
    expect(instructions).toContain('cannot browse other repositories');
  });

  it('lists readable repos and drops the "cannot browse" line when repos.read is set', () => {
    const withAccess = makeConfig({ repos: { read: ['acme/infra', 'acme/shared'] } });
    const instructions = assemblePrompt({
      mode: 'mention',
      config: withAccess,
      context,
      event,
      trigger: { mode: 'mention', explicit: true },
    }).instructions;
    expect(instructions).toContain('READ access to these repositories: acme/infra, acme/shared');
    expect(instructions).toContain('GH_TOKEN');
    expect(instructions).not.toContain('cannot browse other repositories');
  });

  it("says 'any repository' for repos.read: all, and mentions gh on GitHub", () => {
    const all = makeConfig({ repos: { read: 'all' } });
    const instructions = assemblePrompt({ mode: 'mention', config: all, context, event, trigger: { mode: 'mention', explicit: true } })
      .instructions;
    expect(instructions).toContain('any repository your token can access');
    expect(instructions).toContain('gh api');
  });

  it('on Forgejo, points at git / the Forgejo API instead of gh', () => {
    const cfg = makeConfig({ repos: { read: ['acme/infra'] } });
    const forgejoEvent = { ...event, forge: 'forgejo' } as ForgeEvent;
    const instructions = assemblePrompt({
      mode: 'mention',
      config: cfg,
      context,
      event: forgejoEvent,
      trigger: { mode: 'mention', explicit: true },
    }).instructions;
    expect(instructions).toContain('Forgejo API');
    expect(instructions).not.toContain('gh api');
    expect(instructions).toContain('GH_TOKEN');
  });

  it('omits the note when the prompt is fully overridden (that caller owns the base)', () => {
    const overridden = makeConfig({ prompt: { instructions: '', override: 'Custom base prompt.' } });
    const instructions = assemblePrompt({
      mode: 'mention',
      config: overridden,
      context,
      event,
      trigger: { mode: 'mention', explicit: true },
    }).instructions;
    expect(instructions).toContain('Custom base prompt.');
    expect(instructions).not.toContain('single checked-out repository');
  });
});

/** Assemble the review-mode instructions at a given strictness level. */
function reviewInstructions(strictness: number, override?: string): string {
  const cfg = makeConfig({
    prompt: { instructions: '', ...(override ? { override } : {}) },
    modes: {},
    review: { commentOnly: false, strictness },
  });
  return assemblePrompt({ mode: 'review', config: cfg, context, event, trigger: { mode: 'review', explicit: true } })
    .instructions;
}

describe('assemblePrompt — review strictness', () => {
  it('uses the lenient guidance at level 1', () => {
    const instructions = reviewInstructions(1);
    expect(instructions).toContain("You are crab'd, an autonomous code reviewer.");
    expect(instructions).toContain('block a merge');
    expect(instructions).toContain('approve readily');
  });

  it('uses the default high-signal guidance at level 2', () => {
    expect(reviewInstructions(2)).toContain('high-signal findings over exhaustive nitpicking');
  });

  it('uses the pedantic guidance at level 5', () => {
    const instructions = reviewInstructions(5);
    expect(instructions).toContain('Review pedantically');
    expect(instructions).toContain('"no issues found" as a last resort');
  });
});

describe('assemblePrompt — voice note', () => {
  it('appends the anti-glazing voice note to a built-in prompt', () => {
    expect(assemble()).toContain('Voice: write plainly and directly');
    expect(reviewInstructions(2)).toContain('do not open with praise or congratulations');
  });

  it('omits the voice note when the prompt is fully overridden', () => {
    expect(reviewInstructions(2, 'Custom base prompt.')).not.toContain('Voice: write plainly and directly');
  });
});

// --- Diff compression -------------------------------------------------------

/** Build a `diff --git` section for `path` from pre-rendered hunk strings. */
function section(path: string, hunks: string[]): string {
  const header = `diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}`;
  return `${header}\n${hunks.join('\n')}`;
}

/** A single added-lines hunk. */
function hunk(oldStart: number, lines: string[]): string {
  return `@@ -${oldStart},0 +${oldStart},${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`;
}

const sourceSection = section('src/auth.ts', [hunk(1, ['const x = 1;', 'return x;'])]);
const lockSection = section('pnpm-lock.yaml', [hunk(1, ['dep: 1.0.0', 'dep2: 2.0.0'])]);
// ~50 hunks of ~500 chars → well over the per-file cap, so it gets clipped to the hunks that fit.
const bigSection = section(
  'src/big.ts',
  Array.from({ length: 50 }, (_, i) => hunk(i * 10 + 1, [`BIGLINE-${i}-${'x'.repeat(480)}`])),
);

const changedFiles: ForgeChangedFile[] = [
  { path: 'src/auth.ts', status: 'modified', additions: 2, deletions: 0 },
  { path: 'pnpm-lock.yaml', status: 'modified', additions: 812, deletions: 40 },
  { path: 'src/big.ts', status: 'modified', additions: 500, deletions: 0 },
];

describe('compressDiff', () => {
  it('keeps a normal source file intact and unfenced-noted', () => {
    const out = compressDiff(sourceSection, changedFiles);
    expect(out).toContain('```diff');
    expect(out).toContain('const x = 1;');
    // Nothing omitted → no trailing note.
    expect(out).not.toContain('compressed or omitted');
  });

  it('drops low-signal files (lockfiles) and lists them with their counts', () => {
    const out = compressDiff([sourceSection, lockSection].join('\n'), changedFiles);
    expect(out).toContain('const x = 1;'); // source kept
    expect(out).not.toContain('dep: 1.0.0'); // lockfile body dropped
    expect(out).toContain('`pnpm-lock.yaml` (lockfile, +812/-40)');
  });

  it('clips an oversized file to the hunks that fit and notes how many', () => {
    const out = compressDiff(bigSection, changedFiles);
    expect(out).toContain('BIGLINE-0-'); // first hunk kept
    expect(out).not.toContain('BIGLINE-49-'); // last hunk clipped
    expect(out).toMatch(/of 50 hunks shown/);
  });

  it('stops once the global budget is spent and marks the rest not shown', () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      section(`src/f${i}.ts`, [hunk(1, [`FILE${i}MARK-${'x'.repeat(6000)}`])]),
    );
    const files: ForgeChangedFile[] = many.map((_, i) => ({
      path: `src/f${i}.ts`,
      status: 'modified',
      additions: 1,
      deletions: 0,
    }));
    const out = compressDiff(many.join('\n'), files);
    expect(out).toContain('FILE0MARK-'); // early files included
    expect(out).not.toContain('FILE7MARK-'); // late files dropped
    expect(out).toContain('not shown (diff budget)');
    // Body stays near the budget rather than concatenating all ~48k of input.
    expect(out.length).toBeLessThan(30_000);
  });

  it('falls back to a fenced truncation when the input is not a git diff', () => {
    const out = compressDiff('this is not a diff at all', []);
    expect(out.startsWith('```diff')).toBe(true);
    expect(out).toContain('this is not a diff at all');
  });
});

describe('assemblePrompt — diff toggle', () => {
  const diffContext: ForgeContext = {
    repo,
    comments: [],
    changedFiles,
    diff: [sourceSection, lockSection].join('\n'),
  };

  it('compresses the diff by default (lockfile body dropped, omissions noted)', () => {
    const message = assemblePrompt({
      mode: 'review',
      config: makeConfig({ modes: {}, review: { commentOnly: false, strictness: 2 } }),
      context: diffContext,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
    expect(message).toContain('## Diff');
    expect(message).toContain('const x = 1;');
    expect(message).not.toContain('dep: 1.0.0');
    expect(message).toContain('compressed or omitted');
  });

  it('sends the full diff when context.full_diff is on', () => {
    const message = assemblePrompt({
      mode: 'review',
      config: makeConfig({
        modes: {},
        review: { commentOnly: false, strictness: 2 },
        context: { instructionFiles: true, skills: true, fullDiff: true },
      }),
      context: diffContext,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
    expect(message).toContain('dep: 1.0.0'); // full lockfile body present
    expect(message).not.toContain('compressed or omitted'); // no compression note
  });
});

// --- Bounded & deduped context bodies --------------------------------------

const issue: ForgeContext['issue'] = {
  number: 7,
  title: 'Fix it',
  body: 'the description',
  author: 'dev',
  labels: [],
  state: 'open',
};

/** Assemble just the user `message`, over a base issue context, with per-test context/event overrides. */
function messageWith(over: { context?: Partial<ForgeContext>; event?: Partial<ForgeEvent> } = {}): string {
  const ctx = { repo, comments: [], changedFiles: [], issue, ...over.context } as ForgeContext;
  const evt = { ...event, ...over.event } as ForgeEvent;
  return assemblePrompt({ mode: 'mention', config, context: ctx, event: evt, trigger: { mode: 'mention', explicit: true } }).message;
}

describe('renderContext — bounded & deduped bodies', () => {
  it('truncates an oversized PR/issue body and notes it', () => {
    const out = messageWith({ context: { issue: { ...issue, body: 'B'.repeat(6_500) } } });
    expect(out).toContain('[truncated');
    expect(out).not.toContain('B'.repeat(6_100)); // full body not carried through
  });

  it('leaves a short body unchanged and renders (no description) for an empty body', () => {
    const short = messageWith({ context: { issue: { ...issue, body: 'short body' } } });
    expect(short).toContain('short body');
    expect(short).not.toContain('[truncated');

    const empty = messageWith({ context: { issue: { ...issue, body: '' } } });
    expect(empty).toContain('(no description)');
    expect(empty).not.toContain('[truncated');
  });

  it('truncates an oversized triggering comment', () => {
    const out = messageWith({ event: { comment: { id: 99, author: 'dev', body: 'T'.repeat(4_500), createdAt: '' } } });
    expect(out).toContain('## Triggering comment');
    expect(out).toContain('[truncated');
    expect(out).not.toContain('T'.repeat(4_100));
  });

  it('truncates an oversized recent comment', () => {
    const out = messageWith({ context: { comments: [{ id: 1, author: 'dev', body: 'R'.repeat(2_500), createdAt: '' }] } });
    expect(out).toContain('## Recent comments');
    expect(out).toContain('[truncated');
    expect(out).not.toContain('R'.repeat(2_100));
  });

  it('renders the triggering comment once, never duplicated in recent comments', () => {
    const trigger = { id: 42, author: 'dev', body: 'PLEASE-REVIEW-THIS', createdAt: '' };
    const out = messageWith({
      context: { comments: [{ id: 1, author: 'a', body: 'earlier note', createdAt: '' }, trigger] },
      event: { comment: trigger },
    });
    expect(out).toContain('## Triggering comment');
    expect(out.split('PLEASE-REVIEW-THIS').length - 1).toBe(1); // body appears exactly once
    expect(out).toContain('earlier note'); // the non-trigger comment still shows
  });

  it('omits Recent comments entirely when the only comment is the trigger', () => {
    const trigger = { id: 42, author: 'dev', body: 'only the trigger', createdAt: '' };
    const out = messageWith({ context: { comments: [trigger] }, event: { comment: trigger } });
    expect(out).not.toContain('## Recent comments');
    expect(out).toContain('## Triggering comment');
  });
});

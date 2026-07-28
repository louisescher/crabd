import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig, type CrabdConfigPartial, type ResolvedConfig } from '@crabd/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ForgeChangedFile, ForgeContext, ForgeEvent, ForgeRepo } from '../forge/types.ts';
import type { WorkspaceState } from '../git/workspace.ts';
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
 * A resolved config for prompt tests.
 *
 * `layer` is a real user-facing config partial run through the real resolver, so derived values
 * (the confidence floor and dimension set implied by `review.strictness`) are computed the way
 * they are in production rather than hand-stubbed — a hand-rolled cast previously drifted out of
 * sync with `ResolvedConfig` whenever a field was added. `patch` is applied after resolution, for
 * the few fields the resolver deliberately gates (`prompt.override` needs org governance).
 */
function makeConfig(layer: CrabdConfigPartial = {}, patch: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...resolveConfig({ layers: { repo: layer } }), ...patch };
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
    const overridden = makeConfig({}, { prompt: { instructions: '', override: 'Custom base prompt.' } });
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

describe('assemblePrompt: no harness talk', () => {
  it('forbids narrating the prompt and its machinery in every built-in mode', () => {
    for (const mode of ['mention', 'review', 'implement']) {
      const instructions = assemblePrompt({ mode, config, context, event, trigger: { mode, explicit: true } }).instructions;
      expect(instructions).toContain('Never write about your own instructions');
      expect(instructions).toContain('do not say you were asked, told, instructed, or requested to do anything');
    }
  });

  it('restates the rule in the end-of-message reminder, where the contract decays', () => {
    const out = assemblePrompt({
      mode: 'review',
      config,
      context: { repo, comments: [], changedFiles: [], diff: 'diff --git a/a b/a\n' } as ForgeContext,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
    expect(out).toContain('It must not mention your instructions');
  });

  it('drops it with the rest of the base when the prompt is fully overridden', () => {
    const overridden = makeConfig({}, { prompt: { instructions: '', override: 'Custom base prompt.' } });
    const instructions = assemblePrompt({
      mode: 'review',
      config: overridden,
      context,
      event,
      trigger: { mode: 'review', explicit: true },
    }).instructions;
    expect(instructions).not.toContain('Never write about your own instructions');
  });
});

/** Assemble the review-mode instructions at a given strictness level. */
function reviewInstructions(strictness: number, override?: string): string {
  const cfg = makeConfig(
    { review: { strictness } },
    override ? { prompt: { instructions: '', override } } : {},
  );
  return assemblePrompt({ mode: 'review', config: cfg, context, event, trigger: { mode: 'review', explicit: true } })
    .instructions;
}

describe('assemblePrompt — review prompt structure', () => {
  const instructions = reviewInstructions(2);

  it('frames the job adversarially rather than as summarising the diff', () => {
    expect(instructions).toContain("You are crab'd, an autonomous code reviewer");
    expect(instructions).toContain('it is to find where it breaks');
  });

  it('names the reviewer rationalisations and rebuts them', () => {
    expect(instructions).toContain('## Recognize your own rationalizations');
    expect(instructions).toContain('"The diff looks fine."');
    expect(instructions).toContain('"I have enough findings."');
  });

  it('mandates reading the real code and finding callers before judging', () => {
    expect(instructions).toContain('## Method');
    expect(instructions).toContain('**Read the real code.**');
    expect(instructions).toContain('**Find the callers.**');
    expect(instructions).toContain('A finding about code you have not opened is not a finding');
  });

  it('carries both refutation gates', () => {
    expect(instructions).toContain('## Before you report a finding');
    expect(instructions).toContain('**Already handled.**');
    expect(instructions).toContain('**Intentional.**');
    expect(instructions).toContain('**Not actionable.**');
    // The counterweight matters as much as the gate — without it this becomes blanket suppression.
    expect(instructions).toContain('Do not use these as excuses to wave away real bugs');
    expect(instructions).toContain('## Before you approve');
  });

  it('ships numbered exclusions and precedents', () => {
    expect(instructions).toContain('## Do not report');
    expect(instructions).toContain('1. Race conditions, TOCTOU');
    expect(instructions).toContain('## Precedents');
    expect(instructions).toContain('1. Environment variables, CI inputs');
  });

  it('states scope, anchoring, and the finding contract', () => {
    expect(instructions).toContain('## Scope');
    expect(instructions).toContain('pre-existing problem');
    expect(instructions).toContain('## Anchoring findings');
    expect(instructions).toContain('## Finding contract');
    expect(instructions).toContain('`failureScenario`');
    expect(instructions).toContain('Rejected — no scenario, no evidence, nothing traced:');
  });

  it('makes zero findings a legitimate outcome, at every strictness level', () => {
    for (const level of [1, 2, 3, 4, 5]) {
      const at = reviewInstructions(level);
      expect(at).toContain('Zero findings is a good outcome when the change is sound');
      expect(at).toContain('Do not manufacture findings to look thorough');
      // The old level 3-5 guidance told the model to keep looking until it found something,
      // which is a direct instruction to pad. It must not come back.
      expect(at).not.toContain('as a last resort');
      expect(at).not.toContain('look until you find it');
    }
  });

  it('tells the model how to handle its own earlier reviews', () => {
    expect(instructions).toContain('## If you have reviewed this before');
    expect(instructions).toContain('withdraw it');
  });
});

describe('assemblePrompt — strictness drives the dials, not adjectives', () => {
  it('raises the confidence floor as strictness falls', () => {
    expect(reviewInstructions(1)).toContain('Do not report anything below 9');
    expect(reviewInstructions(2)).toContain('Do not report anything below 7');
    expect(reviewInstructions(5)).toContain('Do not report anything below 4');
  });

  it('reviews only correctness and security at level 1', () => {
    const at1 = reviewInstructions(1);
    expect(at1).toContain('- **correctness**');
    expect(at1).toContain('- **security**');
    expect(at1).not.toContain('- **duplication**');
    expect(at1).not.toContain('- **efficiency**');
  });

  it('enables every dimension at level 5', () => {
    const at5 = reviewInstructions(5);
    for (const slug of ['correctness', 'security', 'concurrency-and-resources', 'error-handling', 'efficiency', 'duplication', 'api-and-compatibility', 'test-coverage', 'repo-convention']) {
      expect(at5).toContain(`- **${slug}**`);
    }
  });

  it('honours an explicit dimension list over the strictness default', () => {
    const cfg = makeConfig({ review: { strictness: 1, dimensions: ['efficiency'] } });
    const out = assemblePrompt({ mode: 'review', config: cfg, context, event, trigger: { mode: 'review', explicit: true } }).instructions;
    expect(out).toContain('- **efficiency**');
    expect(out).not.toContain('- **correctness**');
  });

  it('honours an explicit min_confidence over the strictness default', () => {
    const cfg = makeConfig({ review: { strictness: 5, min_confidence: 10 } });
    const out = assemblePrompt({ mode: 'review', config: cfg, context, event, trigger: { mode: 'review', explicit: true } }).instructions;
    expect(out).toContain('Do not report anything below 10');
  });

  it('appends configured exclusions and precedents to the built-in lists', () => {
    const cfg = makeConfig({
      review: { exclusions: ['Never comment on the legacy adapter.'], precedents: ['Our IDs are opaque.'] },
    });
    const out = assemblePrompt({ mode: 'review', config: cfg, context, event, trigger: { mode: 'review', explicit: true } }).instructions;
    expect(out).toContain('Never comment on the legacy adapter.');
    expect(out).toContain('Our IDs are opaque.');
    // Built-ins survive alongside them rather than being replaced.
    expect(out).toContain('Race conditions, TOCTOU');
  });

  it('leaves non-review modes untouched by the review prompt', () => {
    const mention = assemble();
    expect(mention).not.toContain('## Finding contract');
    expect(mention).not.toContain('## Do not report');
  });
});

describe('review-only context sections', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,3 @@',
    ' const a = 1;',
    '+const b = 2;',
    ' const c = 3;',
    '',
  ].join('\n');
  const changedFiles: ForgeChangedFile[] = [{ path: 'src/a.ts', status: 'modified', additions: 1, deletions: 0 }];

  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crabd-assemble-'));
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src/a.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function message(mode: string, cwd?: string, workspace?: WorkspaceState): string {
    return assemblePrompt({
      mode,
      config: makeConfig(),
      context: { repo, comments: [], changedFiles, diff } as ForgeContext,
      event,
      trigger: { mode, explicit: true },
      ...(cwd ? { cwd } : {}),
      ...(workspace ? { workspace } : {}),
    }).message;
  }

  it('tells the review which lines it may anchor to', () => {
    const out = message('review', dir);
    expect(out).toContain('## Where you may anchor inline findings');
    expect(out).toContain('`src/a.ts`: 1-3');
  });

  it('sends the changed file at HEAD with authoritative line numbers', () => {
    const out = message('review', dir);
    expect(out).toContain('## Changed files at HEAD (line-numbered)');
    expect(out).toContain('authoritative line numbers');
    expect(out).toContain('     1→const a = 1;');
    expect(out).toContain('     3→const c = 3;');
  });

  it('omits the file-contents section when there is no checkout to read from', () => {
    const out = message('review');
    expect(out).not.toContain('## Changed files at HEAD');
    // The anchoring section needs only the diff, so it still appears.
    expect(out).toContain('## Where you may anchor inline findings');
  });

  it('withholds the file contents when the checkout does not contain the change', () => {
    const out = message('review', dir, {
      status: '',
      recentCommits: [],
      headSha: 'bbbb222',
      expectedHeadSha: 'aaaa111',
      matchesPrHead: false,
      containsPrHead: false,
    });
    // The files on disk are the pre-change version; sending them under the diff's line numbers
    // would be worse than sending nothing.
    expect(out).not.toContain('## Changed files at HEAD');
    expect(out).toContain('## Where you may anchor inline findings');
  });

  it('still sends the file contents from a merge-ref checkout, which does contain the change', () => {
    const out = message('review', dir, {
      status: '',
      recentCommits: [],
      headSha: 'bbbb222',
      expectedHeadSha: 'aaaa111',
      matchesPrHead: false,
      containsPrHead: true,
    });
    expect(out).toContain('## Changed files at HEAD (line-numbered)');
  });

  it('adds neither section for a non-review mode', () => {
    const out = message('mention', dir);
    expect(out).not.toContain('## Where you may anchor inline findings');
    expect(out).not.toContain('## Changed files at HEAD');
  });

  it('skips a file it cannot read rather than failing the run', () => {
    const out = assemblePrompt({
      mode: 'review',
      config: makeConfig(),
      context: {
        repo,
        comments: [],
        changedFiles: [{ path: 'src/gone.ts', status: 'modified', additions: 1, deletions: 0 }],
        diff,
      } as ForgeContext,
      event,
      trigger: { mode: 'review', explicit: true },
      cwd: dir,
    }).message;
    expect(out).not.toContain('## Changed files at HEAD');
    expect(out).toContain('## Diff');
  });

  it('windows a large file around its hunks instead of sending the whole thing', () => {
    const big = mkdtempSync(join(tmpdir(), 'crabd-big-'));
    try {
      mkdirSync(join(big, 'src'), { recursive: true });
      // 4000 lines of ~14 chars each — comfortably past the whole-file limit.
      const lines = Array.from({ length: 4_000 }, (_, i) => `const v${i} = ${i};`);
      writeFileSync(join(big, 'src/big.ts'), `${lines.join('\n')}\n`);

      const bigDiff = [
        'diff --git a/src/big.ts b/src/big.ts',
        '--- a/src/big.ts',
        '+++ b/src/big.ts',
        '@@ -2000,1 +2000,1 @@',
        '+const v1999 = 1999;',
        '',
      ].join('\n');

      const out = assemblePrompt({
        mode: 'review',
        config: makeConfig(),
        context: {
          repo,
          comments: [],
          changedFiles: [{ path: 'src/big.ts', status: 'modified', additions: 1, deletions: 0 }],
          diff: bigDiff,
        } as ForgeContext,
        event,
        trigger: { mode: 'review', explicit: true },
        cwd: big,
      }).message;

      expect(out).toContain('window around the changes');
      // The window is centred on the hunk and labelled with its true start line...
      expect(out).toContain('lines 1960-2040:');
      expect(out).toContain('  2000→const v1999 = 1999;');
      // ...and lines far from the change are not sent.
      expect(out).not.toContain('const v10 = 10;');
    } finally {
      rmSync(big, { recursive: true, force: true });
    }
  });
});

describe('criticalReviewReminder', () => {
  function reviewMessage(layer: CrabdConfigPartial = {}): string {
    return assemblePrompt({
      mode: 'review',
      config: makeConfig(layer),
      context,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
  }

  it('closes the review user turn with the non-negotiables', () => {
    const message = reviewMessage();
    expect(message).toContain('Before you answer, check each finding against the contract');
    expect(message).toContain('confidence` of at least 7');
    expect(message.trimEnd().endsWith('Zero findings is a valid and often correct answer.')).toBe(true);
  });

  it('tracks the configured confidence floor', () => {
    expect(reviewMessage({ review: { min_confidence: 9 } })).toContain('confidence` of at least 9');
  });

  it('is omitted for modes with no finding contract to drift from', () => {
    const message = assemblePrompt({ mode: 'mention', config: makeConfig(), context, event, trigger: { mode: 'mention', explicit: true } }).message;
    expect(message).not.toContain('Before you answer, check each finding');
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
    // Nothing omitted → no trailing manifest.
    expect(out).not.toContain('**Not fully shown above.**');
  });

  it('drops low-signal files (lockfiles) and lists them with their counts', () => {
    const out = compressDiff([sourceSection, lockSection].join('\n'), changedFiles);
    expect(out).toContain('const x = 1;'); // source kept
    expect(out).not.toContain('dep: 1.0.0'); // lockfile body dropped
    expect(out).toContain('- `pnpm-lock.yaml` — lockfile, +812/-40');
  });

  it('clips an oversized file and names the line ranges it did not show', () => {
    const out = compressDiff(bigSection, changedFiles);
    expect(out).toContain('BIGLINE-0-'); // first hunk kept
    expect(out).not.toContain('BIGLINE-49-'); // last hunk clipped
    expect(out).toMatch(/of 50 hunks omitted/);
    // The point of the change: the model is told *where* the gap is, not just how big it is.
    expect(out).toMatch(/covering lines \d/);
    expect(out).toContain('read the file at HEAD at the line ranges named below');
    // And is steered away from a recovery path a shallow CI checkout cannot provide.
    expect(out).toContain('do not try `git diff`');
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
      config: makeConfig(),
      context: diffContext,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
    expect(message).toContain('## Diff');
    expect(message).toContain('const x = 1;');
    expect(message).not.toContain('dep: 1.0.0');
    expect(message).toContain('**Not fully shown above.**');
  });

  it('does not offer low-signal files as anchor targets', () => {
    const message = assemblePrompt({
      mode: 'review',
      config: makeConfig(),
      context: diffContext,
      event,
      trigger: { mode: 'review', explicit: true },
    }).message;
    // The lockfile's diff body was dropped and the prompt forbids reviewing it, so inviting a
    // finding anchored there would be contradictory.
    expect(message).toContain('## Where you may anchor inline findings');
    expect(message).toContain('- `src/auth.ts`:');
    expect(message).not.toMatch(/- `pnpm-lock\.yaml`: /);
  });

  it('sends the full diff when context.full_diff is on', () => {
    const message = assemblePrompt({
      mode: 'review',
      config: makeConfig({ context: { full_diff: true } }),
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

describe('renderContext — workspace state', () => {
  function messageWithWorkspace(workspace?: WorkspaceState): string {
    return assemblePrompt({
      mode: 'review',
      config,
      context: { repo, comments: [], changedFiles: [], issue } as ForgeContext,
      event,
      trigger: { mode: 'review', explicit: true },
      ...(workspace ? { workspace } : {}),
    }).message;
  }

  const clean: WorkspaceState = {
    branch: 'feat',
    headSha: 'aaaa111',
    status: '',
    recentCommits: ['aaaa111 the change'],
    expectedHeadSha: 'aaaa111',
    matchesPrHead: true,
  };

  it('omits the workspace block when no state was resolved', () => {
    expect(messageWithWorkspace()).not.toContain('## Workspace');
  });

  it('renders ref, HEAD, and commits without warning when the tree is the PR head', () => {
    const out = messageWithWorkspace(clean);
    expect(out).toContain('## Workspace');
    expect(out).toContain('`feat`');
    expect(out).toContain('aaaa111');
    expect(out).toContain('Working tree is clean.');
    expect(out).not.toContain('NOT this pull request');
  });

  it('warns loudly and names both shas when the tree is not the PR head', () => {
    const out = messageWithWorkspace({ ...clean, headSha: 'bbbb222', matchesPrHead: false, containsPrHead: false });
    expect(out).toContain("**The working tree is NOT this pull request's head.**");
    expect(out).toContain('reading one gives you the pre-change version');
    expect(out).toContain('bbbb222'); // what is checked out
    expect(out).toContain('aaaa111'); // what should have been
  });

  it('notes a merge-ref checkout instead of warning, since the change is in the tree', () => {
    const out = messageWithWorkspace({ ...clean, headSha: 'bbbb222', matchesPrHead: false, containsPrHead: true });
    expect(out).toContain('**This checkout is a merge of this pull request into its base branch');
    expect(out).toContain('read them from disk as usual');
    expect(out).not.toContain('NOT this pull request');
    expect(out).not.toContain('pre-change version');
  });

  it('does not warn when the match is simply unknown', () => {
    const { matchesPrHead: _drop, ...unknown } = clean;
    expect(messageWithWorkspace(unknown)).not.toContain('NOT this pull request');
  });

  it('reports a detached HEAD and an unclean tree', () => {
    const { branch: _drop, ...detached } = clean;
    const out = messageWithWorkspace({ ...detached, status: ' M src/a.ts' });
    expect(out).toContain('(detached HEAD)');
    expect(out).toContain('src/a.ts');
    expect(out).not.toContain('Working tree is clean.');
  });

  it('truncates an oversized status block', () => {
    const out = messageWithWorkspace({ ...clean, status: ` M ${'z'.repeat(2_500)}` });
    expect(out).toContain('[truncated');
    expect(out).not.toContain('z'.repeat(2_100));
  });
});

import type { ResolvedConfig } from '@crabd/config';
import { describe, expect, it } from 'vitest';
import type { ForgeContext, ForgeEvent, ForgeRepo } from '../forge/types.ts';
import { assemblePrompt } from './assemble.ts';
import type { ProjectContext } from './project.ts';

const repo: ForgeRepo = {
  owner: 'acme',
  name: 'app',
  slug: 'acme/app',
  defaultBranch: 'main',
  isPrivate: true,
};

const config = {
  prompt: { instructions: '' },
  modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
} as unknown as ResolvedConfig;

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
    const withAccess = {
      prompt: { instructions: '' },
      modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
      repos: { read: ['acme/infra', 'acme/shared'] },
    } as unknown as ResolvedConfig;
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
    const all = {
      prompt: { instructions: '' },
      modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
      repos: { read: 'all' },
    } as unknown as ResolvedConfig;
    const instructions = assemblePrompt({ mode: 'mention', config: all, context, event, trigger: { mode: 'mention', explicit: true } })
      .instructions;
    expect(instructions).toContain('any repository your token can access');
    expect(instructions).toContain('gh api');
  });

  it('on Forgejo, points at git / the Forgejo API instead of gh', () => {
    const cfg = {
      prompt: { instructions: '' },
      modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
      repos: { read: ['acme/infra'] },
    } as unknown as ResolvedConfig;
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
    const overridden = {
      prompt: { instructions: '', override: 'Custom base prompt.' },
      modes: { mention: { name: 'mention', enabled: true, instructions: '' } },
    } as unknown as ResolvedConfig;
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
  const cfg = {
    prompt: { instructions: '', ...(override ? { override } : {}) },
    modes: {},
    review: { commentOnly: false, strictness },
  } as unknown as ResolvedConfig;
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

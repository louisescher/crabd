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
  return assemblePrompt({ mode: 'mention', config, context, event, trigger: { mode: 'mention' }, project }).instructions;
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

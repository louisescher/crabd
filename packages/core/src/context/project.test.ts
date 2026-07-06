import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadProjectContext } from './project.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crabd-project-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(rel: string, content: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function skill(name: string, frontmatter: string, body = 'Do the thing.'): void {
  skillIn('.claude', name, frontmatter, body);
}

function skillIn(rootDir: string, name: string, frontmatter: string, body = 'Do the thing.'): void {
  write(join(rootDir, 'skills', name, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`);
}

const BOTH = { instructionFiles: true, skills: true };

describe('loadProjectContext — instruction files', () => {
  it('returns nothing when no files exist', () => {
    expect(loadProjectContext(dir, BOTH)).toEqual({ skills: [] });
  });

  it('reads AGENTS.md', () => {
    write('AGENTS.md', 'Use tabs, not spaces.');
    expect(loadProjectContext(dir, BOTH).instructions).toBe('Use tabs, not spaces.');
  });

  it('reads CLAUDE.md when AGENTS.md is absent', () => {
    write('CLAUDE.md', 'Prefer small PRs.');
    expect(loadProjectContext(dir, BOTH).instructions).toBe('Prefer small PRs.');
  });

  it('labels and includes both when they differ', () => {
    write('AGENTS.md', 'Rule A.');
    write('CLAUDE.md', 'Rule B.');
    const { instructions } = loadProjectContext(dir, BOTH);
    expect(instructions).toContain('### From `AGENTS.md`');
    expect(instructions).toContain('Rule A.');
    expect(instructions).toContain('### From `CLAUDE.md`');
    expect(instructions).toContain('Rule B.');
  });

  it('includes identical content only once (symlink case)', () => {
    write('CLAUDE.md', 'Shared guidance.');
    symlinkSync(join(dir, 'CLAUDE.md'), join(dir, 'AGENTS.md'));
    const { instructions } = loadProjectContext(dir, BOTH);
    expect(instructions).toBe('Shared guidance.');
    expect(instructions).not.toContain('### From');
  });

  it('ignores an empty/whitespace file', () => {
    write('AGENTS.md', '   \n\n');
    expect(loadProjectContext(dir, BOTH).instructions).toBeUndefined();
  });

  it('respects the instructionFiles toggle', () => {
    write('AGENTS.md', 'Rule A.');
    expect(loadProjectContext(dir, { instructionFiles: false, skills: true }).instructions).toBeUndefined();
  });
});

describe('loadProjectContext — skills', () => {
  it('discovers skills with a frontmatter name + description', () => {
    skill('run-tests', 'name: run-tests\ndescription: Use when the user wants to run the test suite.');
    const { skills } = loadProjectContext(dir, BOTH);
    expect(skills).toEqual([
      {
        name: 'run-tests',
        description: 'Use when the user wants to run the test suite.',
        path: join('.claude', 'skills', 'run-tests', 'SKILL.md'),
      },
    ]);
  });

  it('falls back to the directory name when frontmatter omits name', () => {
    skill('deploy', 'description: Use when deploying the app.');
    expect(loadProjectContext(dir, BOTH).skills[0]?.name).toBe('deploy');
  });

  it('skips a skill without a description (no basis to pick it)', () => {
    skill('vague', 'name: vague');
    expect(loadProjectContext(dir, BOTH).skills).toEqual([]);
  });

  it('handles descriptions containing colons (real YAML parse)', () => {
    skill('fmt', 'name: fmt\ndescription: "Format: run the formatter before committing."');
    expect(loadProjectContext(dir, BOTH).skills[0]?.description).toBe('Format: run the formatter before committing.');
  });

  it('returns skills sorted and skips dirs without SKILL.md', () => {
    skill('bbb', 'name: bbb\ndescription: Second.');
    skill('aaa', 'name: aaa\ndescription: First.');
    mkdirSync(join(dir, '.claude', 'skills', 'empty'), { recursive: true });
    expect(loadProjectContext(dir, BOTH).skills.map((s) => s.name)).toEqual(['aaa', 'bbb']);
  });

  it('discovers skills under .agents/skills too', () => {
    skillIn('.agents', 'lint', 'name: lint\ndescription: Use to lint the code.');
    const { skills } = loadProjectContext(dir, BOTH);
    expect(skills).toEqual([
      { name: 'lint', description: 'Use to lint the code.', path: join('.agents', 'skills', 'lint', 'SKILL.md') },
    ]);
  });

  it('merges both roots, sorted by name', () => {
    skillIn('.agents', 'aaa', 'name: aaa\ndescription: From agents.');
    skill('mmm', 'name: mmm\ndescription: From claude.');
    expect(loadProjectContext(dir, BOTH).skills.map((s) => s.name)).toEqual(['aaa', 'mmm']);
  });

  it('lists a skill present in both roots once (.agents wins)', () => {
    skillIn('.agents', 'shared', 'name: shared\ndescription: Canonical.');
    skillIn('.claude', 'shared', 'name: shared\ndescription: Duplicate.');
    const { skills } = loadProjectContext(dir, BOTH);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toEqual({
      name: 'shared',
      description: 'Canonical.',
      path: join('.agents', 'skills', 'shared', 'SKILL.md'),
    });
  });

  it('respects the skills toggle', () => {
    skill('run-tests', 'name: run-tests\ndescription: Use to run tests.');
    expect(loadProjectContext(dir, { instructionFiles: true, skills: false }).skills).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { summarizeToolArgs } from './tool-log.ts';

describe('summarizeToolArgs: bash', () => {
  it('returns the command', () => {
    expect(summarizeToolArgs('bash', { command: 'echo hi' })).toBe('echo hi');
  });

  it('appends the timeout when set', () => {
    expect(summarizeToolArgs('bash', { command: 'echo hi', timeout: 30 })).toBe('echo hi (timeout 30s)');
  });

  it('flattens a multi-line command to one line', () => {
    expect(summarizeToolArgs('bash', { command: 'echo hi\n  echo bye' })).toBe('echo hi echo bye');
  });

  it('clips a very long command and reports the original character count', () => {
    const long = 'x'.repeat(300);
    expect(summarizeToolArgs('bash', { command: long })).toBe(`${'x'.repeat(240)}... (300 chars)`);
  });
});

describe('summarizeToolArgs: read', () => {
  it('returns the path', () => {
    expect(summarizeToolArgs('read', { path: '/foo.ts' })).toBe('/foo.ts');
  });

  it('appends the offset as a line number when set', () => {
    expect(summarizeToolArgs('read', { path: '/foo.ts', offset: 42 })).toBe('/foo.ts from line 42');
  });
});

describe('summarizeToolArgs: write', () => {
  it('returns only the path, never the content', () => {
    const result = summarizeToolArgs('write', { path: '/foo.ts', content: 'SECRET_CONTENT_VALUE' });
    expect(result).toBe('/foo.ts');
    expect(result).not.toContain('SECRET_CONTENT_VALUE');
  });
});

describe('summarizeToolArgs: edit', () => {
  it('returns the path, never oldText or newText', () => {
    const result = summarizeToolArgs('edit', { path: '/foo.ts', oldText: 'OLD_VALUE', newText: 'NEW_VALUE' });
    expect(result).toBe('/foo.ts');
    expect(result).not.toContain('OLD_VALUE');
    expect(result).not.toContain('NEW_VALUE');
  });

  it('appends "(all occurrences)" when replaceAll is true', () => {
    const result = summarizeToolArgs('edit', {
      path: '/foo.ts',
      oldText: 'OLD_VALUE',
      newText: 'NEW_VALUE',
      replaceAll: true,
    });
    expect(result).toBe('/foo.ts (all occurrences)');
    expect(result).not.toContain('OLD_VALUE');
    expect(result).not.toContain('NEW_VALUE');
  });
});

describe('summarizeToolArgs: grep', () => {
  it('returns pattern in path include', () => {
    expect(summarizeToolArgs('grep', { pattern: 'foo', path: 'src', include: '*.ts' })).toBe('foo in src *.ts');
  });

  it('returns just the pattern when there is no path or include', () => {
    expect(summarizeToolArgs('grep', { pattern: 'foo' })).toBe('foo');
  });
});

describe('summarizeToolArgs: glob', () => {
  it('returns the pattern', () => {
    expect(summarizeToolArgs('glob', { pattern: '**/*.ts' })).toBe('**/*.ts');
  });

  it('returns pattern in path when a path is given', () => {
    expect(summarizeToolArgs('glob', { pattern: '**/*.ts', path: 'src' })).toBe('**/*.ts in src');
  });
});

describe('summarizeToolArgs: task', () => {
  it('returns agent: description', () => {
    expect(summarizeToolArgs('task', { agent: 'general-purpose', description: 'find bugs' })).toBe(
      'general-purpose: find bugs',
    );
  });
});

describe('summarizeToolArgs: report_progress, update_branch, remember', () => {
  it('report_progress returns the message', () => {
    expect(summarizeToolArgs('report_progress', { message: 'reading files' })).toBe('reading files');
  });

  it('update_branch returns the reason', () => {
    expect(summarizeToolArgs('update_branch', { reason: 'rebase onto main' })).toBe('rebase onto main');
  });

  it('remember returns the name', () => {
    expect(summarizeToolArgs('remember', { name: 'no-barrel-files' })).toBe('no-barrel-files');
  });
});

describe('summarizeToolArgs: unknown tools and bad args', () => {
  it('returns undefined for an unknown tool name', () => {
    expect(summarizeToolArgs('some_unknown_tool', { foo: 'bar' })).toBeUndefined();
  });

  it('returns undefined when args is undefined', () => {
    expect(summarizeToolArgs('bash', undefined)).toBeUndefined();
  });

  it('returns undefined when args is a string', () => {
    expect(summarizeToolArgs('bash', 'echo hi')).toBeUndefined();
  });

  it('returns undefined when args is an array', () => {
    expect(summarizeToolArgs('bash', ['echo hi'])).toBeUndefined();
  });
});

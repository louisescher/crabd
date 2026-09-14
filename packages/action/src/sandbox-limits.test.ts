import type { SandboxFactory } from '@flue/runtime';
import { describe, expect, it } from 'vitest';
import { withCommandTimeout } from './sandbox-limits.ts';

interface ExecCall {
  command: string;
  timeoutMs?: number;
}

function fakeFactory(behaviour: (command: string, signal?: AbortSignal) => Promise<unknown>): {
  factory: SandboxFactory;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const factory = {
    createSandbox: async () =>
      ({
        exec: async (command: string, opts?: { timeoutMs?: number; signal?: AbortSignal }) => {
          calls.push({ command, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
          return behaviour(command, opts?.signal);
        },
        readFile: async () => '',
        writeFile: async () => {},
      }) as never,
  } as SandboxFactory;
  return { factory, calls };
}

const ok = async () => ({ stdout: 'done', stderr: '', exitCode: 0 });

async function exec(
  factory: SandboxFactory,
  command: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const sandbox = (await factory.createSandbox({ id: 'test' })) as unknown as {
    exec: (c: string, o?: unknown) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  return sandbox.exec(command, opts);
}

describe('withCommandTimeout', () => {
  it('applies the cap when the caller asks for no timeout', async () => {
    const { factory, calls } = fakeFactory(ok);
    await exec(withCommandTimeout(factory, 5_000), 'echo hi');
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  it('keeps a shorter timeout the caller asked for', async () => {
    const { factory, calls } = fakeFactory(ok);
    await exec(withCommandTimeout(factory, 5_000), 'echo hi', { timeoutMs: 1_000 });
    expect(calls[0]?.timeoutMs).toBe(1_000);
  });

  it('clamps a longer timeout down to the cap', async () => {
    const { factory, calls } = fakeFactory(ok);
    await exec(withCommandTimeout(factory, 5_000), 'echo hi', { timeoutMs: 600_000 });
    expect(calls[0]?.timeoutMs).toBe(5_000);
  });

  it('returns a 124 result naming the limit when the command outlives it', async () => {
    const { factory } = fakeFactory(
      (_command, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const result = await exec(withCommandTimeout(factory, 30), 'sleep 60');
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('limits.command_seconds');
  });

  it('rethrows an abort that came from the caller, and not from the cap', async () => {
    const { factory } = fakeFactory(
      (_command, signal) =>
        new Promise((_resolve, reject) => {
          const fail = (): void => reject(new Error('caller went away'));
          if (signal?.aborted) fail();
          else signal?.addEventListener('abort', fail);
        }),
    );
    const controller = new AbortController();
    const wrapped = withCommandTimeout(factory, 60_000);
    const call = exec(wrapped, 'sleep 60', { signal: controller.signal });
    setTimeout(() => controller.abort(), 5);
    await expect(call).rejects.toThrow('caller went away');
  });

  it('passes the factory through untouched when the cap is zero', () => {
    const { factory } = fakeFactory(ok);
    expect(withCommandTimeout(factory, 0)).toBe(factory);
  });
});

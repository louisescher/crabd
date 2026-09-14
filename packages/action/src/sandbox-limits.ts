import type { SandboxFactory } from '@flue/runtime';

/**
 * Wrap a sandbox so no single shell command can run longer than `capMs`.
 *
 * flue's `bash` tool passes a timeout only when the model asks for one, and a model that omits it
 * gets a command with no ceiling at all. One run spent 272 seconds in a cold `pnpm typecheck` and
 * another 110 in a second one, better than half its wall clock, with nothing able to stop either.
 *
 * The cap sits on `exec`, so it covers every route into the shell. A model that asks for less than
 * the cap keeps its own shorter timeout.
 */
export function withCommandTimeout(factory: SandboxFactory, capMs: number): SandboxFactory {
  if (!(capMs > 0)) return factory;

  const bound = async (sandbox: Awaited<ReturnType<SandboxFactory['createSandbox']>>) => {
    const exec = sandbox.exec.bind(sandbox);
    return {
      ...sandbox,
      exec: async (command: string, opts?: Parameters<typeof exec>[1]) => {
        const requested = opts?.timeoutMs;
        const timeoutMs = requested === undefined ? capMs : Math.min(requested, capMs);
        const own = AbortSignal.timeout(timeoutMs);
        const signal = opts?.signal ? AbortSignal.any([own, opts.signal]) : own;
        const killed = (): { stdout: string; stderr: string; exitCode: number } => ({
          stdout: '',
          stderr:
            `[crabd] Command killed after ${Math.round(timeoutMs / 1000)}s, the limit for one command ` +
            '(`limits.command_seconds`). Run a narrower command, or pass a smaller `timeout` and work in steps.',
          exitCode: 124,
        });
        try {
          const result = await exec(command, { ...opts, timeoutMs, signal });
          return own.aborted && !opts?.signal?.aborted ? killed() : result;
        } catch (error) {
          if (own.aborted && !opts?.signal?.aborted) return killed();
          throw error;
        }
      },
    };
  };

  return {
    createSandbox: async (options) => bound(await factory.createSandbox(options)),
    ...(factory.tools ? { tools: factory.tools } : {}),
  };
}

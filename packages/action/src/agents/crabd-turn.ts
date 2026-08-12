import { defineTool, useDataWriter, useInitialData, useMcpConnection, useModel, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import { getMode } from '@crabd/core';
import { configuredWebSearchTools, mcpConnections, progressTool, rememberTool, runContext } from '../run-context.ts';

/**
 * Per-instance facts, recorded at creation. These used to travel as `CRABD_*` env vars because the
 * turn ran in a subprocess; an instance's creation data is the direct replacement, and it lets one
 * agent serve every mode and every model in the fallback chain.
 */
export interface TurnCreation {
  mode: string;
  model: string;
  instructions: string;
}

/**
 * One crab'd turn. The orchestration around it — the rate-limit fallback chain, the repair pass, the
 * turn budget, the verify stage — lives in the runner, not here: those are decisions about *how many*
 * turns to spend and on which model, and v2 puts that in the caller rather than inside the agent.
 *
 * The answer leaves through a terminal `submit` tool validated by the mode's own output schema.
 * `harness.prompt`'s `result` option would give the same forced-schema guarantee, but it runs in a
 * scratch conversation the delivered message never reaches.
 */
export function CrabdTurn() {
  const ctx = runContext();
  const creation = useInitialData<TurnCreation | undefined>();
  const mode = creation ? getMode(creation.mode) : undefined;

  useModel(creation?.model ?? DEFAULT_MODEL, {
    ...(ctx.thinkingLevel ? { thinkingLevel: ctx.thinkingLevel } : {}),
  });
  useSandbox(local({ cwd: ctx.cwd, env: ctx.sandboxEnv }));

  for (const connection of mcpConnections()) useMcpConnection(connection);

  const progress = progressTool(creation?.mode ?? 'mention');
  if (progress) useTool(progress);
  // Absent unless this run is a reply to crab'd in a repo it can actually commit to, so the model is
  // never offered a way to record something that would then fail to land.
  const remember = rememberTool();
  if (remember) useTool(remember);
  for (const tool of configuredWebSearchTools()) useTool(tool);

  // The mode owns the answer's shape. Without a resolved mode there is nothing to validate against,
  // so the tool takes any object and the runner rejects it — a missing mode is a caller bug, and
  // failing here would lose the run's logs.
  const ResultSchema = (mode?.outputSchema ?? v.record(v.string(), v.unknown())) as v.GenericSchema;
  const writeResult = useDataWriter('result', { schema: ResultSchema });

  useTool(
    defineTool({
      name: 'submit',
      description:
        "Record your final answer for this turn. Call it exactly once, when you are done investigating, then stop.",
      input: ResultSchema as never,
      run: ({ data }) => {
        writeResult(data);
        return { output: 'recorded', terminate: true };
      },
    }),
  );

  // flue 1 got this guarantee from `harness.prompt({ result })`, which injected a `finish` tool and
  // re-prompted until the model called it. A terminal tool has no such loop, so the directive has to
  // be stated — and the runner nudges once if the model still answers in prose.
  const instructions = creation?.instructions ?? '';
  return [instructions, SUBMIT_DIRECTIVE].filter(Boolean).join('\n\n');
}

const SUBMIT_DIRECTIVE = [
  '## Answering',
  'You MUST record your answer by calling the `submit` tool exactly once, when you are done.',
  'Plain-text replies are discarded: an answer that is not submitted through the tool never reaches the user.',
  'Investigate first with the tools you have, then call `submit` and stop.',
].join('\n');

CrabdTurn.agentName = 'crabd-turn';

const DEFAULT_MODEL = 'anthropic/claude-sonnet-4-6';

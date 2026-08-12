import { defineTool, useDataWriter, useInitialData, useModel, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { REFUTER_INSTRUCTIONS, RefuterVerdictSchema } from '@crabd/core';
import { runContext } from '../run-context.ts';
import type { ThinkingLevel } from '@crabd/config';

export interface RefuterCreation {
  model: string;
  thinking?: ThinkingLevel;
}

/**
 * The blinded second opinion used by the verify stage.
 *
 * A top-level agent rather than a subagent, for two reasons: v2 delegation is model-driven through
 * the `task` tool, so a subagent could not be fanned out deterministically, and `useDataWriter`
 * throws in a subagent render. Addressed one instance per finding, it gets the claim and the same
 * checkout but never the reviewer's conversation.
 */
export function CrabdRefuter() {
  const ctx = runContext();
  const creation = useInitialData<RefuterCreation | undefined>();

  useModel(creation?.model ?? 'anthropic/claude-sonnet-4-6', {
    ...(creation?.thinking ? { thinkingLevel: creation.thinking } : {}),
  });
  useSandbox(local({ cwd: ctx.cwd, env: ctx.sandboxEnv }));

  const writeVerdict = useDataWriter('verdict', { schema: RefuterVerdictSchema });

  useTool(
    defineTool({
      name: 'submit_verdict',
      description: 'Record your verdict on the finding. Call it exactly once, then stop.',
      input: RefuterVerdictSchema as never,
      run: ({ data }) => {
        writeVerdict(data);
        return { output: 'recorded', terminate: true };
      },
    }),
  );

  return `${REFUTER_INSTRUCTIONS}\n\nAnswer by calling submit_verdict exactly once. Do not reply with prose.`;
}

CrabdRefuter.agentName = 'crabd-refuter';

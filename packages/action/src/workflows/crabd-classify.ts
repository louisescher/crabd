import { defineAgent, defineWorkflow } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

/**
 * Cheap intent router: given a bare mention ("@crabd please review again"), decide which
 * crab'd mode the user actually wants so the CLI can route to the full mode (a re-review
 * request → the review mode's inline findings + verdict, not a lone comment).
 *
 * Deliberately minimal: low thinking, no tools, tiny structured output. It reuses the primary
 * model (CRABD_MODEL) so no extra provider wiring is needed — the providers registered in
 * app.ts from the CLI's env already cover it.
 */
const agent = defineAgent(() => ({
  model: process.env.CRABD_MODEL ?? 'anthropic/claude-haiku-4-5',
  // Routing is a small classification — keep the thinking budget minimal.
  thinkingLevel: 'minimal' as never,
  instructions: [
    "You are the intent router for crab'd, an autonomous code-review agent on a git forge.",
    'A user mentioned crab\'d in a comment. Pick the single mode that best matches what they want, from the list you are given.',
    '- Pick the review mode when they ask to review, re-review, take another look at, or give feedback on the pull request or its changes.',
    "- Pick the implement mode when they ask crab'd to write, add, fix, refactor, or otherwise change the code.",
    '- Otherwise pick the mention mode (a question or general request).',
    'Only pick the review mode when the comment is on a pull request. Choose exactly one of the offered mode names.',
  ].join('\n'),
  sandbox: local({ cwd: process.env.CRABD_CWD ?? process.cwd(), env: {} }),
}));

export default defineWorkflow({
  agent,
  input: v.object({
    candidates: v.array(v.object({ name: v.string(), description: v.string() })),
    comment: v.string(),
    instruction: v.optional(v.string()),
    isPullRequest: v.boolean(),
    subjectTitle: v.optional(v.string()),
  }),
  async run({ harness, input }) {
    const names = input.candidates.map((c) => c.name);
    // Constrain the answer to the offered modes so the CLI never has to second-guess it.
    const schema = v.object({ mode: v.picklist(names as [string, ...string[]]) });

    const options = input.candidates.map((c) => `- ${c.name}: ${c.description}`).join('\n');
    const message = [
      '## Context',
      `This comment is on a ${input.isPullRequest ? 'pull request' : 'issue'}${input.subjectTitle ? `: "${input.subjectTitle}"` : ''}.`,
      '',
      '## Modes to choose from',
      options,
      '',
      '## Comment',
      input.comment,
      ...(input.instruction ? ['', '## Text after the mention', input.instruction] : []),
    ].join('\n');

    const session = await harness.session();
    const result = (await session.prompt(message, { result: schema })) as unknown as {
      data: { mode: string };
    };
    return { mode: result.data.mode };
  },
});

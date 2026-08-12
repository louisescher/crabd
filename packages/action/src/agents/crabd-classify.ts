import { defineTool, useDataWriter, useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

export interface ClassifyCreation {
  candidates: { name: string; description: string }[];
  model: string;
}

/**
 * Cheap intent router: given a bare mention ("@crabd please review again"), decide which crab'd mode
 * the user actually wants so the CLI can route to the full mode (a re-review request → the review
 * mode's inline findings + verdict, not a lone comment).
 *
 * Deliberately minimal: minimal thinking, no sandbox, no tools beyond the one that answers. The
 * offered modes arrive as creation data so the picklist is built from what the caller registered
 * rather than a list duplicated here.
 */
export function CrabdClassify() {
  const creation = useInitialData<ClassifyCreation | undefined>();
  const names = (creation?.candidates ?? []).map((c) => c.name);

  useModel(creation?.model ?? 'anthropic/claude-haiku-4-5', { thinkingLevel: 'minimal' });

  // Constrain the answer to the offered modes so the CLI never has to second-guess it. A picklist
  // needs at least one option; with none the tool still mounts and simply cannot be satisfied, which
  // surfaces as "no mode part" and leaves the caller's default in place.
  const ModeSchema = v.object({
    mode: names.length > 0 ? v.picklist(names as [string, ...string[]]) : v.string(),
  });
  const writeMode = useDataWriter('mode', { schema: ModeSchema });

  useTool(
    defineTool({
      name: 'pick_mode',
      description: 'Record the chosen mode. Call exactly once, then stop.',
      input: ModeSchema,
      run: ({ data }) => {
        writeMode(data);
        return { output: 'recorded', terminate: true };
      },
    }),
  );

  return [
    "You are the intent router for crab'd, an autonomous code-review agent on a git forge.",
    "A user mentioned crab'd in a comment. Pick the single mode that best matches what they want, from the list you are given.",
    '- Pick the review mode when they ask to review, re-review, take another look at, or give feedback on the pull request or its changes.',
    "- Pick the implement mode when they ask crab'd to write, add, fix, refactor, or otherwise change the code.",
    '- Otherwise pick the mention mode (a question or general request).',
    'Only pick the review mode when the comment is on a pull request. Choose exactly one of the offered mode names.',
    'Answer by calling pick_mode. Do not reply with prose.',
  ].join('\n');
}

CrabdClassify.agentName = 'crabd-classify';

/** The message the router reads. Built here so the caller only supplies facts, not prose. */
export function buildClassifyMessage(input: {
  candidates: { name: string; description: string }[];
  comment: string;
  instruction?: string;
  isPullRequest: boolean;
  subjectTitle?: string;
}): string {
  return [
    '## Context',
    `This comment is on a ${input.isPullRequest ? 'pull request' : 'issue'}${input.subjectTitle ? `: "${input.subjectTitle}"` : ''}.`,
    '',
    '## Modes to choose from',
    input.candidates.map((c) => `- ${c.name}: ${c.description}`).join('\n'),
    '',
    '## Comment',
    input.comment,
    ...(input.instruction ? ['', '## Text after the mention', input.instruction] : []),
  ].join('\n');
}

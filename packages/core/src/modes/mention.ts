import * as v from 'valibot';
import type { FinalizeContext, ModeDefinition } from './registry.ts';
import { commitWorkingChanges, subjectNumber } from './shared.ts';

export const MentionOutputSchema = v.object({
  /** The answer/summary to post back to the user. */
  response: v.string(),
  /** Whether the agent edited files that should be committed. */
  made_changes: v.boolean(),
  /** Suggested branch for any committed changes. */
  branch: v.optional(v.string()),
  /** Commit message for any committed changes. */
  commit_message: v.optional(v.string()),
});

export type MentionOutput = v.InferOutput<typeof MentionOutputSchema>;

/**
 * Why this run must not commit, or `undefined` when it may.
 *
 * A bare mention is a question, not a change request. crab'd used to answer one by pushing a
 * commit to whatever branch the model named (including, in practice, the human's own pull-request
 * branch), which is a surprising reading of an `@crabd` with nothing after it. Committing now
 * takes an actual instruction, checked here rather than left to the model's judgement about
 * whether it was "warranted".
 */
function commitRefusal(ctx: FinalizeContext<MentionOutput>): string | undefined {
  if (!ctx.config.permissions.write) {
    return 'I did not commit anything: writes are turned off for this repository.';
  }
  if (!ctx.trigger.userInstruction?.trim()) {
    return 'I did not commit anything, because this mention did not ask for a change. Say what you want changed and I will make it.';
  }
  return undefined;
}

/**
 * Interactive mention mode: answer the request, and if the agent edited the
 * checked-out repo *and was asked to*, commit those changes to a branch.
 */
export const mentionMode: ModeDefinition<MentionOutput> = {
  name: 'mention',
  description:
    'Answer a question or handle a free-form request about the code or discussion. The default when the user is asking something rather than clearly requesting a code review or an implementation.',
  outputSchema: MentionOutputSchema,
  tools: ['comment', 'commit'],
  writes: 'optional',
  async finalize(ctx) {
    let summary = ctx.data.response;
    if (ctx.data.made_changes) {
      const refusal = commitRefusal(ctx);
      if (refusal) {
        summary += `\n\nℹ️ ${refusal}`;
      } else {
        const number = subjectNumber(ctx.context, ctx.event);
        const branch = ctx.data.branch ?? `crabd/mention-${number ?? 'change'}`;
        const committed = await commitWorkingChanges({
          adapter: ctx.adapter,
          cwd: ctx.cwd,
          branch,
          message: ctx.data.commit_message ?? "crab'd: apply requested changes",
          baseBranch: ctx.context.repo.defaultBranch,
          writesAllowed: ctx.config.permissions.write,
        });
        if (committed) summary += `\n\n✅ Committed changes to \`${branch}\`.`;
      }
    }
    return { summary };
  },
};

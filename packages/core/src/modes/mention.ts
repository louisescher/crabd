import * as v from 'valibot';
import type { ModeDefinition } from './registry.ts';
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
 * Interactive mention mode: answer the request, and if the agent edited the
 * checked-out repo, commit those changes to a branch.
 */
export const mentionMode: ModeDefinition<MentionOutput> = {
  name: 'mention',
  description:
    'Answer a question or handle a free-form request about the code or discussion. The default when the user is asking something rather than clearly requesting a code review or an implementation.',
  outputSchema: MentionOutputSchema,
  tools: ['comment', 'commit'],
  async finalize(ctx) {
    let summary = ctx.data.response;
    if (ctx.data.made_changes) {
      const number = subjectNumber(ctx.context, ctx.event);
      const branch = ctx.data.branch ?? `crabd/mention-${number ?? 'change'}`;
      const committed = await commitWorkingChanges({
        adapter: ctx.adapter,
        cwd: ctx.cwd,
        branch,
        message: ctx.data.commit_message ?? "crab'd: apply requested changes",
        baseBranch: ctx.context.repo.defaultBranch,
      });
      if (committed) summary += `\n\n✅ Committed changes to \`${branch}\`.`;
    }
    return { summary };
  },
};

import * as v from 'valibot';
import type { ModeDefinition } from './registry.ts';
import { commitWorkingChanges, subjectNumber } from './shared.ts';

export const ImplementOutputSchema = v.object({
  /** Summary of what was implemented, posted back to the issue. */
  summary: v.string(),
  /** Title for the opened pull request. */
  pr_title: v.string(),
  /** Body for the opened pull request. */
  pr_body: v.string(),
  /** Branch to commit the implementation to. */
  branch: v.string(),
});

export type ImplementOutput = v.InferOutput<typeof ImplementOutputSchema>;

/** Implement mode: build the change on a branch and open a pull request for the issue. */
export const implementMode: ModeDefinition<ImplementOutput> = {
  name: 'implement',
  outputSchema: ImplementOutputSchema,
  tools: ['comment', 'commit', 'open_pr'],
  async finalize(ctx) {
    const branch = ctx.data.branch || `crabd/implement-${subjectNumber(ctx.context, ctx.event) ?? 'issue'}`;
    const committed = await commitWorkingChanges({
      adapter: ctx.adapter,
      cwd: ctx.cwd,
      branch,
      message: ctx.data.pr_title,
      baseBranch: ctx.context.repo.defaultBranch,
    });

    if (!committed) {
      return { summary: `${ctx.data.summary}\n\n⚠️ No file changes were produced, so no pull request was opened.` };
    }

    const pr = await ctx.adapter.openOrUpdatePR({
      title: ctx.data.pr_title,
      body: ctx.data.pr_body,
      headBranch: branch,
      baseBranch: ctx.context.repo.defaultBranch,
    });
    return { summary: ctx.data.summary, prUrl: pr.url };
  },
};

import * as v from 'valibot';
import type { ModeDefinition } from './registry.ts';
import { subjectNumber } from './shared.ts';

export const ReviewOutputSchema = v.object({
  /** Overall review summary posted as the review body. */
  summary: v.string(),
  /** Review verdict. */
  verdict: v.picklist(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']),
  /** Inline findings anchored to file + line. */
  findings: v.array(
    v.object({
      path: v.string(),
      line: v.number(),
      body: v.string(),
    }),
  ),
});

export type ReviewOutput = v.InferOutput<typeof ReviewOutputSchema>;

/** The verdict as a plain-language sentence (the raw enum is kept for the forge API). */
const VERDICT_LABEL: Record<ReviewOutput['verdict'], string> = {
  APPROVE: 'Good to merge (LGTM)',
  COMMENT: 'Nits found',
  REQUEST_CHANGES: 'Please address the findings before merging',
};

/** Auto-review mode: analyze the PR diff and post a review with inline findings. */
export const reviewMode: ModeDefinition<ReviewOutput> = {
  name: 'review',
  outputSchema: ReviewOutputSchema,
  tools: ['comment', 'review'],
  async finalize(ctx) {
    const number = subjectNumber(ctx.context, ctx.event);
    if (number === undefined) {
      return { summary: ctx.data.summary };
    }

    // `comment_only` keeps crab'd from formally approving/blocking a PR: post a plain
    // COMMENT review regardless of verdict. The verdict still shows in the summary.
    const event = ctx.config.review.commentOnly ? 'COMMENT' : ctx.data.verdict;
    await ctx.adapter.postReview(number, {
      body: ctx.data.summary,
      event, // GitHub/Forgejo require a raw APPROVE/COMMENT/REQUEST_CHANGES value
      comments: ctx.data.findings,
    });

    const count = ctx.data.findings.length;
    const suffix = count === 0 ? '' : ` (${count} inline finding${count === 1 ? '' : 's'})`;
    return { summary: `${ctx.data.summary}\n\n**${VERDICT_LABEL[ctx.data.verdict]}.**${suffix}` };
  },
};

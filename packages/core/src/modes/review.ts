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
    await ctx.adapter.postReview(number, {
      body: ctx.data.summary,
      event: ctx.data.verdict,
      comments: ctx.data.findings,
    });
    return { summary: `${ctx.data.summary}\n\n_Verdict: ${ctx.data.verdict}, ${ctx.data.findings.length} inline finding(s)._` };
  },
};

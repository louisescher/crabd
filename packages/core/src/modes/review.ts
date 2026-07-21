import * as v from 'valibot';
import { commentableLines } from '../context/diff-lines.ts';
import { foldCommentsIntoBody } from '../forge/review-body.ts';
import type { ReviewComment } from '../forge/types.ts';
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

/**
 * Split findings into those a forge can anchor inline (path + line inside a changed hunk) and
 * those that fall outside the diff. GitHub rejects the whole review with 422 "Line could not be
 * resolved" if an inline comment targets a line outside the diff, so out-of-diff findings are
 * kept as text instead. With no diff to check against, everything is treated as inline (the
 * adapter's postReview retains its own fallback for that case).
 */
function partitionFindings(
  findings: ReviewComment[],
  diff: string | undefined,
): { inline: ReviewComment[]; outOfDiff: ReviewComment[] } {
  if (!diff) return { inline: findings, outOfDiff: [] };
  const lines = commentableLines(diff);
  const inline: ReviewComment[] = [];
  const outOfDiff: ReviewComment[] = [];
  for (const f of findings) {
    if (lines.get(f.path)?.has(f.line)) inline.push(f);
    else outOfDiff.push(f);
  }
  return { inline, outOfDiff };
}

/** Auto-review mode: analyze the PR diff and post a review with inline findings. */
export const reviewMode: ModeDefinition<ReviewOutput> = {
  name: 'review',
  description:
    'Review the pull request diff and post inline findings with a verdict. Choose this when the user asks to review, re-review, take another look at, or give feedback on the pull request or its changes.',
  outputSchema: ReviewOutputSchema,
  tools: ['comment', 'review'],
  async finalize(ctx) {
    const number = subjectNumber(ctx.context, ctx.event);
    if (number === undefined) {
      return { summary: ctx.data.summary };
    }

    // Anchor only findings that land inside a changed hunk; the rest are folded into the review
    // body as text so a single out-of-diff line can't 422 the whole review (and lose it).
    const { inline, outOfDiff } = partitionFindings(ctx.data.findings, ctx.context.diff);
    const body = foldCommentsIntoBody(ctx.data.summary, outOfDiff);

    // `comment_only` keeps crab'd from formally approving/blocking a PR: post a plain
    // COMMENT review regardless of verdict. The verdict still shows in the summary.
    const event = ctx.config.review.commentOnly ? 'COMMENT' : ctx.data.verdict;
    await ctx.adapter.postReview(number, {
      body,
      event, // GitHub/Forgejo require a raw APPROVE/COMMENT/REQUEST_CHANGES value
      comments: inline,
    });

    const count = inline.length;
    const suffix = count === 0 ? '' : ` (${count} inline finding${count === 1 ? '' : 's'})`;
    const verdictLine = `**${VERDICT_LABEL[ctx.data.verdict]}.**${suffix}`;
    // Prefix with the configured brand emoji (empty → no emoji), matching the comment leads.
    const emoji = ctx.config.appearance.emoji ? `${ctx.config.appearance.emoji} ` : '';
    return {
      summary: `${body}\n\n${verdictLine}`,
      // The full summary is in the posted review; keep the tracking comment short so it
      // isn't duplicated. See finalizeRun.
      trackingComment: `${emoji}Reviewed this pull request — ${verdictLine}`,
    };
  },
};

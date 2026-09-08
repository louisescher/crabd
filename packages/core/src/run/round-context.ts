import type { ForgeAdapter, ForgeContext } from '../forge/types.ts';
import { debug, warn } from '../logger.ts';

export interface RoundContextResult {
  /**
   * Fingerprint of the feedback this round saw, which keys the claim that collapses the several
   * events one submitted review produces. Names both id sequences and the thread count, because
   * review ids and comment ids come from different tables: a single maximum over the two cannot
   * tell that the smaller-numbered sequence gained an entry.
   */
  feedbackToken: string;
  /** Anything the run should warn about, because it changes what the round could see. */
  advisories: string[];
}

/**
 * Fetch the open feedback and CI state a round needs and attach it to the context.
 *
 * Every fetch is best-effort and independent: a round with no check state is still a round, and a
 * missing permission is worth one advisory rather than a failed run.
 */
export async function attachRoundContext(
  adapter: ForgeAdapter,
  context: ForgeContext,
  options: { maxThreads: number },
): Promise<RoundContextResult> {
  const pr = context.pullRequest;
  const advisories: string[] = [];
  if (!pr) return { feedbackToken: 'none', advisories };

  let commentId = 0;
  let reviewId = 0;
  let threadCount = 0;

  try {
    const threads = await adapter.listReviewThreads(pr.number);
    const open = threads.filter((thread) => !thread.isResolved);
    context.reviewThreads = open.slice(0, options.maxThreads);
    context.omittedThreads = Math.max(0, open.length - (context.reviewThreads?.length ?? 0));
    threadCount = threads.length;
    // Every comment, not just each thread's root: a reviewer replying inside an existing thread
    // adds no root, and a claim that did not move would skip the round their reply asked for.
    for (const thread of threads) {
      commentId = Math.max(commentId, thread.rootCommentId);
      for (const comment of thread.comments) commentId = Math.max(commentId, comment.id);
    }
    debug(() => `round: ${open.length} open thread(s) of ${threads.length}, showing ${context.reviewThreads?.length ?? 0}`);
  } catch (error) {
    // A round that cannot see the conversations would answer none of them and still commit, so the
    // user is told rather than left with a silent no-op.
    warn(`could not read the review threads: ${error instanceof Error ? error.message : String(error)}`);
    advisories.push(
      "crab'd could not read the review conversations on this pull request, so this round answered none of them. The error is in the run log.",
    );
  }

  try {
    const reviews = await adapter.listReviews(pr.number);
    context.reviews = reviews;
    for (const review of reviews) reviewId = Math.max(reviewId, review.id);
  } catch (error) {
    warn(`could not read the submitted reviews: ${error instanceof Error ? error.message : String(error)}`);
  }

  const feedbackToken = `${reviewId}.${commentId}.${threadCount}`;
  if (!pr.headSha) return { feedbackToken, advisories };

  try {
    const checks = await adapter.listChecks(pr.headSha);
    context.checks = checks;
    if (!checks.available && checks.reason) advisories.push(checks.reason);
  } catch (error) {
    warn(`could not read the check state: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { feedbackToken, advisories };
}

import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';

/**
 * Whether this run is a human replying to something crab'd said.
 *
 * This is the mechanical half of the recording gate — the half that can actually be proven. Whether
 * the reply is a *durable correction* rather than a passing remark is left to the tool description
 * and the prompt, because no signal in the payload distinguishes them.
 *
 * Two shapes qualify:
 *
 * - An inline review reply whose thread is rooted at one of crab'd's own findings. This is the
 *   precise case, and the one worth trusting: the human is answering a specific claim.
 * - An issue comment on a subject where crab'd has already commented. Deliberately broader —
 *   forges give issue comments no threading at all, so there is nothing tighter to key on. This is
 *   why a recorded memory is committed somewhere reviewable by default.
 *
 * A bot's reply never qualifies: crab'd answering its own comment, or another automation quoting
 * it, is not a human teaching it anything.
 */
export function isCorrectionReply(context: ForgeContext, event: ForgeEvent): boolean {
  if (!event.comment || event.actor.isBot) return false;

  if (context.replyThread) return context.replyThread.rootIsCrabd;

  const triggerAt = event.comment.createdAt;
  return context.comments.some(
    (c) =>
      c.id !== event.comment!.id &&
      c.body.includes(TRACKING_MARKER) &&
      (!triggerAt || !c.createdAt || c.createdAt <= triggerAt),
  );
}

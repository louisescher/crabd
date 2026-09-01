import type { ForgeContext, ForgeEvent } from '../forge/types.ts';
import { TRACKING_MARKER } from '../report/tracking.ts';

/**
 * Whether this run is a human replying to something crab'd said, or addressing crab'd directly on
 * a subject it has already spoken on.
 *
 * This is the mechanical half of the recording gate — the half that can actually be proven. Whether
 * the reply is a *durable correction* rather than a passing remark is left to the tool description
 * and the prompt, because no signal in the payload distinguishes them.
 *
 * An inline review reply whose thread is rooted at one of crab'd's own findings always qualifies:
 * the human is answering a specific claim. A thread a human started does too, once crab'd has a
 * tracking comment on the subject: an inline reply is itself a trigger, so if it got this far a
 * human addressed crab'd directly inside that thread, and the same standard already applies to a
 * plain issue comment, which forges give no threading at all.
 *
 * A bot's reply never qualifies: crab'd answering its own comment, or another automation quoting
 * it, is not a human teaching it anything.
 */
export function isCorrectionReply(context: ForgeContext, event: ForgeEvent): boolean {
  if (!event.comment || event.actor.isBot) return false;
  if (context.replyThread?.rootIsCrabd) return true;

  const triggerAt = event.comment.createdAt;
  return context.comments.some(
    (c) =>
      c.id !== event.comment!.id &&
      c.body.includes(TRACKING_MARKER) &&
      (!triggerAt || !c.createdAt || c.createdAt <= triggerAt),
  );
}

import { FINDING_MARKER } from '../report/tracking.ts';
import type { ForgeComment } from './types.ts';

/**
 * One inline review comment as the forges report it, narrowed to the fields threading needs.
 *
 * Kept structural rather than importing Octokit's response type: the same shape has to accept
 * Forgejo's payload, which carries a subset (see {@link buildReviewThread} on missing reply ids).
 */
export interface RawReviewComment {
  id: number;
  body?: string | null;
  user?: { login?: string } | null;
  created_at?: string;
  /** The comment this one replies to. Absent on a thread root — and on every Forgejo comment. */
  in_reply_to_id?: number | null;
  path?: string;
  /** New-side line, null once the line has scrolled out of the current diff. */
  line?: number | null;
  /** The line the comment was originally left on, which survives a rebase of the diff. */
  original_line?: number | null;
  /**
   * Offset into the diff hunk. Forgejo/Gitea reports this instead of a new-side line, so it is used
   * only to tell co-located threads apart — never rendered as a line number, which it is not.
   */
  position?: number | null;
  original_position?: number | null;
  /** The few lines of diff the forge stores alongside the root comment. */
  diff_hunk?: string;
}

/** An inline review conversation: what it is anchored to, and every comment in it. */
export interface ReviewThread {
  /** New-side path the thread hangs off. */
  path: string;
  /** New-side line, when the forge still reports one. */
  line?: number;
  /** The diff hunk the forge stored with the root comment. */
  diffHunk?: string;
  /** Root first, then replies in chronological order. */
  comments: ForgeComment[];
  /** Whether the thread was started by one of crab'd's own findings. */
  rootIsCrabd: boolean;
}

function toForgeComment(raw: RawReviewComment): ForgeComment {
  return {
    id: raw.id,
    body: raw.body ?? '',
    author: raw.user?.login ?? 'unknown',
    createdAt: raw.created_at ?? '',
  };
}

/** Chronological, falling back to id order when timestamps are absent or equal. */
function byTime(a: RawReviewComment, b: RawReviewComment): number {
  const at = a.created_at ?? '';
  const bt = b.created_at ?? '';
  if (at !== bt) return at < bt ? -1 : 1;
  return a.id - b.id;
}

/**
 * Reconstruct the inline review thread containing `triggerCommentId`.
 *
 * GitHub reports `in_reply_to_id` on every reply, so the thread is the transitive closure of that
 * chain: walk up to the root, then take everything that resolves to the same root.
 *
 * Forgejo/Gitea does not report `in_reply_to_id`, which would make every comment its own root and
 * lose the conversation entirely. So when the trigger has no reply id and nothing points at it, the
 * thread falls back to *co-location*: every comment on the same `path` and line. That is what a
 * reviewer means by "this thread" on a forge without explicit threading, and it degrades to just the
 * triggering comment when even the path is unknown rather than returning nothing.
 *
 * Returns `undefined` only when `triggerCommentId` isn't in `raw` at all.
 */
export function buildReviewThread(
  raw: RawReviewComment[],
  triggerCommentId: number,
): ReviewThread | undefined {
  const byId = new Map(raw.map((c) => [c.id, c]));
  const trigger = byId.get(triggerCommentId);
  if (!trigger) return undefined;

  // Walk to the root, guarding against a cycle in hostile or buggy payload data.
  const rootOf = (start: RawReviewComment): RawReviewComment => {
    let current = start;
    const seen = new Set<number>([current.id]);
    while (current.in_reply_to_id) {
      const parent = byId.get(current.in_reply_to_id);
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };

  const declaredRoot = rootOf(trigger);
  const anchorLine = (c: RawReviewComment): number | undefined => c.line ?? c.original_line ?? undefined;
  // What co-location compares on. A real line where the forge gives one, otherwise the diff position
  // Forgejo reports — enough to keep two threads on the same file apart, which a bare path is not.
  const anchorKey = (c: RawReviewComment): number | undefined =>
    anchorLine(c) ?? c.original_position ?? c.position ?? undefined;

  let members = raw.filter((c) => rootOf(c).id === declaredRoot.id);
  let root = declaredRoot;

  // No explicit threading anywhere near this comment (the Forgejo shape): fall back to co-location.
  // Every comment on the same file at the same anchor is what a reviewer means by "this thread" on a
  // forge that does not record reply ids. Guarded on a known anchor, so an unanchored comment stays
  // a thread of one rather than collecting every comment in the file.
  const threaded = members.length > 1 || Boolean(trigger.in_reply_to_id);
  const key = anchorKey(declaredRoot);
  if (!threaded && declaredRoot.path && key !== undefined) {
    members = raw.filter((c) => c.path === declaredRoot.path && anchorKey(c) === key);
    // Without reply ids every comment looks like its own root, so the trigger would name itself and
    // the thread would read backwards. The earliest co-located comment is the one that started it —
    // and the one whose body decides whether crab'd opened the thread.
    root = [...members].sort(byTime)[0] ?? declaredRoot;
  }

  const ordered = [...members].sort(byTime);
  // The root leads even if a reply somehow carries an earlier timestamp than the comment it answers.
  const comments = [root, ...ordered.filter((c) => c.id !== root.id)].map(toForgeComment);

  const line = anchorLine(root);
  return {
    path: root.path ?? '',
    ...(line !== undefined ? { line } : {}),
    ...(root.diff_hunk ? { diffHunk: root.diff_hunk } : {}),
    comments,
    rootIsCrabd: (root.body ?? '').includes(FINDING_MARKER),
  };
}

import type { ReviewComment } from './types.ts';

/**
 * Append review comments that couldn't be anchored inline to the review body as a text section,
 * so they survive even when the forge won't take them as inline comments (a line outside the
 * diff). Used both to pre-empt the 422 in review mode and as the adapters' last-resort fallback.
 *
 * Findings carry multi-line markdown (severity heading, failure scenario, fix), so each gets its
 * own subsection rather than a bullet — a multi-line body inside a list item renders as a mess and
 * these are exactly the findings that already lost their inline anchor, so they should at least be
 * readable.
 */
export function foldCommentsIntoBody(body: string, comments: ReviewComment[]): string {
  if (comments.length === 0) return body;
  const items = comments
    .map((c) => `#### \`${c.path}:${c.line}\`\n\n${c.body.trim()}`)
    .join('\n\n');
  return `${body}\n\n---\n\n**Additional findings** (outside the diff, so not anchored inline):\n\n${items}`;
}

import type { ReviewComment } from './types.ts';

/**
 * Append review comments that couldn't be anchored inline to the review body as a text section,
 * so they survive even when the forge won't take them as inline comments (a line outside the
 * diff). Used both to pre-empt the 422 in review mode and as the adapters' last-resort fallback.
 */
export function foldCommentsIntoBody(body: string, comments: ReviewComment[]): string {
  if (comments.length === 0) return body;
  const items = comments.map((c) => `- \`${c.path}:${c.line}\` — ${c.body}`).join('\n');
  return `${body}\n\n---\n\n**Additional findings** (outside the diff, so not anchored inline):\n\n${items}`;
}

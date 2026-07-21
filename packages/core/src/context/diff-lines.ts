import { splitSections } from './assemble.ts';

/** New-side line ranges parsed from one `@@ -a,b +c,d @@` header. */
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Enumerate the new-side (RIGHT) line numbers a forge can anchor a review comment to, per file.
 *
 * GitHub's `pulls.createReview` resolves `comments[].line` against the PR diff and rejects the
 * *entire* review with 422 "Line could not be resolved" if any comment targets a line outside a
 * changed hunk. The commentable lines are the **added (`+`)** and **context (` `)** lines shown in
 * the hunks (both live on the new side); removed (`-`) lines are LEFT-side only and can't be
 * targeted through our `line`-only model. Forgejo's `new_position` has the same new-side semantics.
 *
 * Keyed by the new-file path (matches `finding.path`). Files with no resolvable hunks are omitted.
 */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const { path, text } of splitSections(diff)) {
    const lines = new Set<number>();
    let newLine = 0;
    let inHunk = false;
    for (const raw of text.split('\n')) {
      const header = raw.match(HUNK_HEADER);
      if (header) {
        newLine = Number(header[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      // A line that doesn't start with a diff marker ends the hunk body (e.g. a trailing
      // `diff --git` guard); splitSections already scopes `text` to one file, so this is defensive.
      const marker = raw[0];
      if (marker === '+' || marker === ' ') {
        lines.add(newLine);
        newLine++;
      } else if (marker === '-' || marker === '\\') {
        // Removed line (LEFT side) or "\ No newline at end of file" — no new-side line consumed.
      } else {
        inHunk = false;
      }
    }
    if (lines.size > 0) map.set(path, lines);
  }
  return map;
}

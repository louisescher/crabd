/**
 * Unified-diff parsing shared by prompt assembly (`assemble.ts`) and comment anchoring
 * (`diff-lines.ts`). It lives in its own module so those two can both depend on it without
 * depending on each other.
 */

/** Extract the target path from one `diff --git` section (prefers the new path). */
function sectionPath(section: string): string | undefined {
  const plus = section.match(/^\+\+\+ b\/(.+)$/m)?.[1];
  if (plus && plus !== '/dev/null') return plus.trim();
  const minus = section.match(/^--- a\/(.+)$/m)?.[1];
  if (minus && minus !== '/dev/null') return minus.trim();
  return section.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2]?.trim();
}

/** Split a whole unified diff into per-file sections, each starting at its `diff --git` line. */
export function splitSections(diff: string): { path: string; text: string }[] {
  const start = diff.indexOf('diff --git ');
  if (start === -1) return [];
  return diff
    .slice(start)
    .split(/\n(?=diff --git )/)
    .flatMap((text) => {
      const path = sectionPath(text);
      return path ? [{ path, text }] : [];
    });
}

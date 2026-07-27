import { splitSections } from './diff-parse.ts';

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

/** Collapse a set of line numbers into ascending `12-31` / `44` range strings. */
function toRanges(lines: Set<number>): string[] {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start: number | undefined;
  let prev: number | undefined;

  for (const line of sorted) {
    if (start === undefined || prev === undefined) {
      start = prev = line;
      continue;
    }
    if (line === prev + 1) {
      prev = line;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = line;
  }
  if (start !== undefined && prev !== undefined) {
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  }
  return ranges;
}

/** One file's anchorable line ranges, ready to render into the prompt. */
export interface AnchorableFile {
  path: string;
  /** Compact ascending ranges, e.g. `['12-31', '44', '90-102']`. */
  ranges: string[];
}

/**
 * Describe the lines a forge will accept an inline comment on, per file, as compact ranges.
 *
 * {@link commentableLines} computes the same set but was only ever consulted *after* the model
 * answered, to avoid a 422 — so the model had to derive line numbers by arithmetic off an `@@`
 * header, got them wrong, and had its findings demoted to plain body text. Rendering these ranges
 * into the prompt turns the anchoring rule from something the model must infer into something it
 * is told (see `## Where you may anchor inline findings` in `assemble.ts`).
 */
export function describeCommentableLines(diff: string): AnchorableFile[] {
  const out: AnchorableFile[] = [];
  for (const [path, lines] of commentableLines(diff)) {
    out.push({ path, ranges: toRanges(lines) });
  }
  return out;
}

/**
 * Rebuild the line sets from {@link describeCommentableLines} output.
 *
 * The inverse of that function, so the anchorable set can cross a process boundary as compact
 * ranges instead of by re-sending the whole diff — which matters because the model turn runs in a
 * subprocess whose input is passed as a command-line argument.
 */
export function expandCommentableLines(files: AnchorableFile[]): Map<string, Set<number>> {
  // Note `Number('')` is 0, not NaN, so a blank or malformed entry would otherwise expand to
  // "line 0" — never a real line, and it would let a finding snap onto nonsense.
  const lineNumber = (raw: string | undefined): number | undefined => {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return undefined;
    const value = Number(raw);
    return value >= 1 ? value : undefined;
  };

  const map = new Map<string, Set<number>>();
  for (const { path, ranges } of files) {
    const lines = new Set<number>();
    for (const range of ranges) {
      const [rawStart, rawEnd] = range.split('-');
      const start = lineNumber(rawStart);
      if (start === undefined) continue;
      const end = rawEnd === undefined ? start : lineNumber(rawEnd);
      if (end === undefined || end < start) continue;
      for (let line = start; line <= end; line++) lines.add(line);
    }
    if (lines.size > 0) map.set(path, lines);
  }
  return map;
}

/**
 * Re-anchor a finding whose line isn't commentable onto the nearest line that is, within
 * `tolerance`. Returns `undefined` when nothing is close enough, in which case the caller should
 * fall back to rendering the finding as text in the review body.
 *
 * Models miss by a line or two — pointing at a `}` just past the hunk, or at the declaration above
 * it. Demoting an otherwise good finding for that is a worse outcome than moving it a few lines and
 * saying so.
 */
export function snapToCommentableLine(
  lines: Map<string, Set<number>>,
  path: string,
  line: number,
  tolerance: number,
): number | undefined {
  const candidates = lines.get(path);
  if (!candidates) return undefined;
  if (candidates.has(line)) return line;

  let best: number | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = Math.abs(candidate - line);
    // Tie-break toward the earlier line so the choice is deterministic.
    if (distance < bestDistance || (distance === bestDistance && best !== undefined && candidate < best)) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= tolerance ? best : undefined;
}

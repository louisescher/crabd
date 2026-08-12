import { load } from 'js-yaml';

/** The leading `---` YAML block of a markdown file, and everything after it. */
export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

// The inner group is optional so an empty block (`---\n---`) still parses as frontmatter — a human
// deleting the last field should not silently turn their memory's own delimiters into its body.
const BLOCK = /^---\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*\r?\n?/;

/**
 * Split a markdown file into its frontmatter record and its body.
 *
 * Unparseable or absent frontmatter yields an empty record and the whole source as the body, so a
 * malformed file degrades to plain markdown rather than failing the run. Both callers read repo
 * content crab'd does not control.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const match = BLOCK.exec(source);
  if (!match) return { data: {}, body: source.trim() };

  const body = source.slice(match[0].length).trim();
  if (!match[1]) return { data: {}, body };
  try {
    const doc = load(match[1]);
    const data = doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
    return { data, body };
  } catch {
    return { data: {}, body };
  }
}

/** The frontmatter record alone, for callers that don't need the body. */
export function parseFrontmatter(source: string): Record<string, unknown> {
  return splitFrontmatter(source).data;
}

/** A frontmatter field as a trimmed non-empty string, or undefined. */
export function frontmatterString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

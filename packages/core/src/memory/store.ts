import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { frontmatterString, splitFrontmatter } from '../context/frontmatter.ts';

/** Default location of the memory directory, relative to the checkout root. */
export const DEFAULT_MEMORY_DIR = '.crabd/memory';

/**
 * Total characters of memory text allowed into a prompt.
 *
 * Memories are re-sent on every turn of the agentic loop, so an unbounded directory would quietly
 * crowd out the diff it is supposed to help judge. Mirrors `MAX_INSTRUCTIONS_CHARS` in
 * `context/project.ts`, which bounds AGENTS.md for the same reason.
 */
const MAX_MEMORY_CHARS = 20_000;

/** One recorded memory: a durable fact about this repository, with its provenance. */
export interface MemoryEntry {
  /** Slug identifying the memory, from frontmatter or the filename. */
  name: string;
  /** The memory itself — what crab'd should do differently. */
  body: string;
  /** Where it came from, normally a permalink to the comment that taught it. */
  source?: string;
  /** ISO date it was recorded, used to keep the newest when the caps bite. */
  recorded?: string;
  /** Repo-relative path, so a human (or the agent) can go edit or delete it. */
  path: string;
}

export interface LoadMemoriesOptions {
  /** Memory directory, relative to `cwd`. Defaults to {@link DEFAULT_MEMORY_DIR}. */
  dir?: string;
  /** Maximum number of memories to load. */
  maxEntries?: number;
}

/** Turn a proposed memory name into a safe, stable filename stem. */
export function memorySlug(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'memory';
}

/** Newest first, so the caps below drop the stalest memories rather than an arbitrary set. */
function byRecordedDesc(a: MemoryEntry, b: MemoryEntry): number {
  const at = a.recorded ?? '';
  const bt = b.recorded ?? '';
  if (at !== bt) return at < bt ? 1 : -1;
  return a.name.localeCompare(b.name);
}

/**
 * Load the repository's recorded memories.
 *
 * Best-effort throughout, like every other repo-authored input crab'd reads: an absent directory, an
 * unreadable file, or one with broken frontmatter yields fewer memories rather than a failed run.
 * A human hand-editing these files should never be able to break a review by fumbling the YAML.
 *
 * Two caps apply after sorting newest-first — a count, and a total character budget. Both exist
 * because this text rides along on every turn.
 */
export function loadMemories(cwd: string, options: LoadMemoriesOptions = {}): MemoryEntry[] {
  const dir = options.dir ?? DEFAULT_MEMORY_DIR;
  const root = join(cwd, dir);

  let files: string[];
  try {
    if (!statSync(root).isDirectory()) return [];
    files = readdirSync(root).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }

  const entries: MemoryEntry[] = [];
  for (const file of files.sort()) {
    let source: string;
    try {
      source = readFileSync(join(root, file), 'utf-8');
    } catch {
      continue;
    }

    const { data, body } = splitFrontmatter(source);
    if (!body.trim()) continue;

    const name = frontmatterString(data, 'name') ?? file.replace(/\.md$/, '');
    entries.push({
      name,
      body: body.trim(),
      ...(frontmatterString(data, 'source') ? { source: frontmatterString(data, 'source')! } : {}),
      ...(frontmatterString(data, 'recorded') ? { recorded: frontmatterString(data, 'recorded')! } : {}),
      path: `${dir}/${file}`,
    });
  }

  entries.sort(byRecordedDesc);

  const capped = options.maxEntries && options.maxEntries > 0 ? entries.slice(0, options.maxEntries) : entries;
  const kept: MemoryEntry[] = [];
  let used = 0;
  for (const entry of capped) {
    used += entry.body.length;
    if (used > MAX_MEMORY_CHARS) break;
    kept.push(entry);
  }
  return kept;
}

export interface WriteMemoryInput {
  name: string;
  body: string;
  source?: string;
  /** ISO date. Passed in rather than read from the clock so callers can keep runs reproducible. */
  recorded: string;
  dir?: string;
}

/**
 * Write one memory into the checkout, returning its repo-relative path.
 *
 * Keyed on the slug, so recording a refined version of an existing memory supersedes it instead of
 * accumulating a near-duplicate the model then has to reconcile against itself.
 */
export function writeMemory(cwd: string, input: WriteMemoryInput): string {
  const dir = input.dir ?? DEFAULT_MEMORY_DIR;
  const relative = `${dir}/${memorySlug(input.name)}.md`;
  const absolute = join(cwd, relative);

  if (!existsSync(dirname(absolute))) mkdirSync(dirname(absolute), { recursive: true });

  const frontmatter = [
    '---',
    `name: ${memorySlug(input.name)}`,
    ...(input.source ? [`source: ${input.source}`] : []),
    `recorded: ${input.recorded}`,
    '---',
  ];
  writeFileSync(absolute, `${frontmatter.join('\n')}\n\n${input.body.trim()}\n`, 'utf-8');
  return relative;
}

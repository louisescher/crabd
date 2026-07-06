import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/** A skill discovered under a repo skills root, summarized for the prompt manifest. */
export interface SkillSummary {
  /** The skill's `name` (from frontmatter, falling back to its directory name). */
  name: string;
  /** The skill's `description` — what it's for / when to use it. */
  description: string;
  /** Repo-relative path to the skill's `SKILL.md`, so the agent can read it on demand. */
  path: string;
}

/** Repo-authored context crab'd pulls into the prompt for a run. */
export interface ProjectContext {
  /** Combined `AGENTS.md` / `CLAUDE.md` guidance, or undefined if none was loaded. */
  instructions?: string;
  /** Skills discovered under the repo skills roots (empty when disabled or none found). */
  skills: SkillSummary[];
}

export interface LoadProjectContextOptions {
  /** Load `AGENTS.md` / `CLAUDE.md` from the checkout root. */
  instructionFiles: boolean;
  /** Discover skills under `.agents/skills/` and `.claude/skills/`. */
  skills: boolean;
}

/** Repo-root instruction files, in the order they're read and appended. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'] as const;

/**
 * Skill roots scanned, in order. Both the AGENTS-ecosystem (`.agents/skills`) and
 * Claude Code (`.claude/skills`) conventions are honored; a skill `name` found in more
 * than one root (e.g. one root symlinked to the other) is listed once.
 */
const SKILL_ROOTS = [
  ['.agents', 'skills'],
  ['.claude', 'skills'],
] as const;

/** Cap the combined instruction text so a huge file can't crowd out the run's context. */
const MAX_INSTRUCTIONS_CHARS = 40_000;

function readFileIfExists(path: string): string | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const content = readFileSync(path, 'utf-8').trim();
    return content.length > 0 ? content : undefined;
  } catch {
    return undefined;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

/**
 * Read the repo's own agent instructions from `AGENTS.md` and `CLAUDE.md` at the
 * checkout root. Both are honored: `AGENTS.md` is the cross-tool convention, `CLAUDE.md`
 * keeps parity for repos migrating from claude-code-action. Identical content (the common
 * symlink / copy case) is included once; otherwise each is labeled and both are included.
 */
function readInstructionFiles(cwd: string): string | undefined {
  const found: { file: string; content: string }[] = [];
  for (const file of INSTRUCTION_FILES) {
    const content = readFileIfExists(join(cwd, file));
    if (content) found.push({ file, content });
  }
  if (found.length === 0) return undefined;

  // Deduplicate identical bodies so an `AGENTS.md` symlinked to `CLAUDE.md` isn't doubled.
  const distinct = found.filter((f, i) => found.findIndex((o) => o.content === f.content) === i);
  const body =
    distinct.length === 1
      ? distinct[0]!.content
      : distinct.map((f) => `### From \`${f.file}\`\n${f.content}`).join('\n\n');
  return truncate(body, MAX_INSTRUCTIONS_CHARS);
}

/** Parse the leading `---` YAML frontmatter block of a SKILL.md into a record. */
function parseFrontmatter(source: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!match) return {};
  try {
    const doc = yaml.load(match[1]!);
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? (doc as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Discover skills under each root in {@link SKILL_ROOTS} (`.agents/skills`, then
 * `.claude/skills`). Each subdirectory with a `SKILL.md` becomes one entry; `name` and
 * `description` come from its frontmatter (name falls back to the directory name). A
 * skill missing a usable description is skipped — without one the agent has no basis to
 * decide when to read it. A `name` already seen in an earlier root is skipped, so a skill
 * present in both roots is listed once. Output is sorted by name for stable prompts.
 */
function discoverSkills(cwd: string): SkillSummary[] {
  const skills: SkillSummary[] = [];
  const seen = new Set<string>();

  for (const segments of SKILL_ROOTS) {
    const root = join(cwd, ...segments);
    if (!isDirectory(root)) continue;

    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }

    for (const dir of entries) {
      const relPath = join(...segments, dir, 'SKILL.md');
      const content = readFileIfExists(join(cwd, relPath));
      if (!content) continue;

      const meta = parseFrontmatter(content);
      const name = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : dir;
      const description = typeof meta.description === 'string' ? meta.description.trim() : '';
      if (!description || seen.has(name)) continue;

      seen.add(name);
      skills.push({ name, description, path: relPath });
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load the repo-authored context (instruction files + skill manifest) for a run, gated
 * by config. Everything is best-effort and read-only: unreadable or absent files yield
 * an empty result rather than failing the run.
 */
export function loadProjectContext(cwd: string, options: LoadProjectContextOptions): ProjectContext {
  const instructions = options.instructionFiles ? readInstructionFiles(cwd) : undefined;
  const skills = options.skills ? discoverSkills(cwd) : [];
  return { ...(instructions ? { instructions } : {}), skills };
}

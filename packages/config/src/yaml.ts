import { load } from 'js-yaml';
import { parseConfigObject, type CrabdConfigPartial } from './schema.ts';

/**
 * Parse a `.crabd.yml` document into a validated partial config.
 * An empty or whitespace-only document resolves to an empty partial.
 * Throws on malformed YAML or a shape that violates the schema.
 */
export function parseConfigYaml(source: string): CrabdConfigPartial {
  // js-yaml throws on a document with no content rather than returning nothing. A `.crabd.yml` that
  // is blank or all comments means "no overrides", not "fail the run". Any document with a real key
  // has a line that is neither blank nor a comment, so this never short-circuits a live config.
  const hasContent = source.split('\n').some((line) => {
    const trimmed = line.trim();
    return trimmed !== '' && !trimmed.startsWith('#');
  });
  if (!hasContent) return {};
  const doc = load(source);
  if (doc === undefined || doc === null) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('crabd config: top-level YAML must be a mapping');
  }
  return parseConfigObject(doc);
}

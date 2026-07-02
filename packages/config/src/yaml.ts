import yaml from 'js-yaml';
import { parseConfigObject, type CrabdConfigPartial } from './schema.ts';

/**
 * Parse a `.crabd.yml` document into a validated partial config.
 * An empty or whitespace-only document resolves to an empty partial.
 * Throws on malformed YAML or a shape that violates the schema.
 */
export function parseConfigYaml(source: string): CrabdConfigPartial {
  const doc = yaml.load(source);
  if (doc === undefined || doc === null) return {};
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('crabd config: top-level YAML must be a mapping');
  }
  return parseConfigObject(doc);
}

import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { createJiti } from 'jiti';

/**
 * The optional `crabd.config.ts` extension module. Owns the parts that want real
 * code rather than YAML: per-mode output schemas (Valibot), custom Flue tools, and
 * custom mode definitions. Values are typed loosely here so `@crabd/config` needn't
 * depend on `@flue/runtime`; `@crabd/core` validates and refines them.
 */
export interface CrabdExtension {
  /** Per-mode Valibot output schemas, keyed by mode name. */
  schemas?: Record<string, unknown>;
  /** Custom, model-callable Flue tool definitions (from `defineTool`). */
  tools?: unknown[];
  /** Custom mode definitions registered into the mode registry. */
  modes?: unknown[];
}

/** Identity helper giving consumers type-checking + editor completion in `crabd.config.ts`. */
export function defineCrabdConfig(extension: CrabdExtension): CrabdExtension {
  return extension;
}

/**
 * Load a `crabd.config.ts` (or `.js`/`.mjs`) extension module at runtime via jiti —
 * no build step required in consumer repos. Returns `undefined` when the file is absent.
 * Accepts the module's `default` export, or the namespace itself as a fallback.
 */
export async function loadCrabdExtension(
  path: string,
  cwd: string = process.cwd(),
): Promise<CrabdExtension | undefined> {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  if (!existsSync(absolute)) return undefined;

  const jiti = createJiti(import.meta.url);
  const mod = (await jiti.import(absolute)) as { default?: CrabdExtension } & CrabdExtension;
  return mod.default ?? mod;
}

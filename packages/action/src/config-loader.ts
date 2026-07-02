import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseConfigObject,
  parseConfigYaml,
  resolveConfig,
  type CrabdConfigPartial,
  type ResolvedConfig,
} from '@crabd/config';
import type { ForgeAdapter, ForgeEvent } from '@crabd/core';

export interface LoadedConfig {
  config: ResolvedConfig;
  /** Absolute path to a `crabd.config.ts` extension, if the repo has one. */
  extensionPath?: string;
}

function parseEnvPartial(raw: string | undefined): CrabdConfigPartial | undefined {
  if (!raw) return undefined;
  return parseConfigYaml(raw);
}

/** Map friendly `CRABD_INPUT_*` action inputs into the inputs config layer. */
function inputsPartial(env: NodeJS.ProcessEnv): CrabdConfigPartial | undefined {
  const raw: Record<string, unknown> = {};
  if (env.CRABD_INPUT_MODEL) raw.model = env.CRABD_INPUT_MODEL;
  if (env.CRABD_INPUT_TRIGGER_PHRASE) raw.trigger_phrase = env.CRABD_INPUT_TRIGGER_PHRASE;
  if (env.CRABD_INPUT_THINKING_LEVEL) raw.thinking_level = env.CRABD_INPUT_THINKING_LEVEL;
  if (env.CRABD_INPUT_PROVIDERS) {
    raw.providers = { allowlist: env.CRABD_INPUT_PROVIDERS.split(',').map((s) => s.trim()).filter(Boolean) };
  }
  if (Object.keys(raw).length === 0) return undefined;
  return parseConfigObject(raw);
}

/**
 * Resolve the layered config for this run:
 * built-in defaults → org config repo → repo `.crabd.yml` → CI inputs → env,
 * with org-locked keys and full-override gating handled by {@link resolveConfig}.
 */
export async function loadResolvedConfig(input: {
  adapter: ForgeAdapter;
  event: ForgeEvent;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LoadedConfig> {
  const env = input.env ?? process.env;
  const { adapter, event, cwd } = input;

  // Org layer: read `.crabd.yml` from the org config repo (default `<owner>/.crabd-config`).
  const orgRepoSlug = env.CRABD_ORG_CONFIG_REPO || `${event.repo.owner}/.crabd-config`;
  const orgConfigPath = env.CRABD_ORG_CONFIG_PATH || '.crabd.yml';
  const orgSource = await adapter.readOrgConfig(orgRepoSlug, orgConfigPath);
  const org = orgSource ? parseConfigYaml(orgSource) : undefined;

  // Repo layer: the checked-out repo's `.crabd.yml`.
  const repoConfigFile = join(cwd, env.CRABD_CONFIG_PATH ?? '.crabd.yml');
  const repo = existsSync(repoConfigFile) ? parseConfigYaml(readFileSync(repoConfigFile, 'utf-8')) : undefined;

  // Inputs layer: friendly action inputs. Env layer: an advanced YAML override blob.
  const inputs = inputsPartial(env);
  const envLayer = parseEnvPartial(env.CRABD_CONFIG_ENV);

  const config = resolveConfig({
    repoSlug: event.repo.slug,
    layers: {
      ...(org ? { org } : {}),
      ...(repo ? { repo } : {}),
      ...(inputs ? { inputs } : {}),
      ...(envLayer ? { env: envLayer } : {}),
    },
  });

  const extensionFile = join(cwd, env.CRABD_EXTENSION_PATH_REL ?? 'crabd.config.ts');
  const extensionPath = existsSync(extensionFile) ? extensionFile : undefined;

  return { config, ...(extensionPath ? { extensionPath } : {}) };
}

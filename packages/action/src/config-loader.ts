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
import { log } from './logger.ts';

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
  if (env.CRABD_INPUT_FALLBACK_MODELS) {
    raw.rate_limit = {
      fallback_models: env.CRABD_INPUT_FALLBACK_MODELS.split(',').map((s) => s.trim()).filter(Boolean),
    };
  }
  if (Object.keys(raw).length === 0) return undefined;
  return parseConfigObject(raw);
}

/** Whether the checkout could be a pull request head rather than the repository's default branch. */
function checkoutMayBeUntrusted(event: ForgeEvent): boolean {
  const onPullRequest = event.pullRequest !== undefined || event.isPullRequest === true;
  if (!onPullRequest) return false;
  const headRef = event.pullRequest?.headRef;
  return headRef === undefined || headRef !== event.repo.defaultBranch;
}

/**
 * Split a partial into the sections only the default branch may set (`permissions`, `governance`,
 * and `prompt.override`, which grants the same authority by another route) and everything else.
 */
function splitTrustedSections(partial: CrabdConfigPartial): {
  trusted?: CrabdConfigPartial;
  rest: CrabdConfigPartial;
} {
  const { permissions, governance, prompt, ...others } = partial;
  const { override, allow_full_override, ...promptRest } = prompt ?? {};
  const trustedPrompt =
    override !== undefined || allow_full_override !== undefined
      ? {
          ...(override !== undefined ? { override } : {}),
          ...(allow_full_override !== undefined ? { allow_full_override } : {}),
        }
      : undefined;

  const rest: CrabdConfigPartial = {
    ...others,
    ...(Object.keys(promptRest).length > 0 ? { prompt: promptRest } : {}),
  };
  if (!permissions && !governance && !trustedPrompt) return { rest };
  return {
    trusted: {
      ...(permissions ? { permissions } : {}),
      ...(governance ? { governance } : {}),
      ...(trustedPrompt ? { prompt: trustedPrompt } : {}),
    },
    rest,
  };
}

/**
 * `permissions.*` / `governance.*` for a pull request run, read from the repository's default
 * branch instead of the checkout so a PR cannot grant itself permissions it is then reviewed
 * under. Call only when {@link checkoutMayBeUntrusted} is true.
 */
async function loadRepoTrustedLayer(
  adapter: ForgeAdapter,
  event: ForgeEvent,
  configPathRel: string,
): Promise<CrabdConfigPartial | undefined> {
  const source = await adapter.readOrgConfig(event.repo.slug, configPathRel);
  if (!source) {
    log(`no default-branch ${configPathRel} found for ${event.repo.slug}; the trusted sections fall through to the org and default layers for this pull request run.`);
    return undefined;
  }

  let parsed: CrabdConfigPartial;
  try {
    parsed = parseConfigYaml(source);
  } catch (error) {
    log(
      `default-branch ${configPathRel} could not be parsed, ignoring it for the trusted sections: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }

  const { trusted } = splitTrustedSections(parsed);
  return trusted;
}

/**
 * Resolve the layered config for this run:
 * built-in defaults → org config repo → repo `.crabd.yml` → repo default branch (the sections a
 * pull request may not set for itself) → CI inputs → env, with org-locked keys and full-override
 * gating handled by {@link resolveConfig}.
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

  // Repo layer: the checked-out repo's `.crabd.yml`. On an untrusted checkout, `permissions.*` /
  // `governance.*` are stripped here and read from the default branch instead, below.
  const repoConfigPathRel = env.CRABD_CONFIG_PATH ?? '.crabd.yml';
  const repoConfigFile = join(cwd, repoConfigPathRel);
  const repoFull = existsSync(repoConfigFile) ? parseConfigYaml(readFileSync(repoConfigFile, 'utf-8')) : undefined;

  const untrustedCheckout = checkoutMayBeUntrusted(event);
  const repo = untrustedCheckout && repoFull ? splitTrustedSections(repoFull).rest : repoFull;
  const repoTrusted = untrustedCheckout ? await loadRepoTrustedLayer(adapter, event, repoConfigPathRel) : undefined;

  // Inputs layer: friendly action inputs. Env layer: an advanced YAML override blob.
  const inputs = inputsPartial(env);
  const envLayer = parseEnvPartial(env.CRABD_CONFIG_ENV);

  const config = resolveConfig({
    repoSlug: event.repo.slug,
    layers: {
      ...(org ? { org } : {}),
      ...(repoTrusted ? { repoTrusted } : {}),
      ...(repo ? { repo } : {}),
      ...(inputs ? { inputs } : {}),
      ...(envLayer ? { env: envLayer } : {}),
    },
  });

  const extensionFile = join(cwd, env.CRABD_EXTENSION_PATH_REL ?? 'crabd.config.ts');
  const extensionPath = existsSync(extensionFile) ? extensionFile : undefined;

  return { config, ...(extensionPath ? { extensionPath } : {}) };
}

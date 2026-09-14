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
 * The repository's own config layer for a pull request run, read from the default branch instead
 * of the checkout.
 *
 * A pull request head is contributor-controlled, and nearly every key in the file decides how the
 * run treats the change it is reviewing: `permissions` grants the write token, `modes` picks which
 * mode runs and injects its instructions, `prompt` and `review` rewrite what the model is told,
 * `sandbox.env` forwards named secrets into a shell the same file can steer, and `providers.custom`
 * points the model call at an arbitrary endpoint. Splitting that into trusted and untrusted halves
 * meant relitigating the boundary with every new key, so the whole layer comes from the branch a
 * maintainer already reviewed.
 *
 * Call only when {@link checkoutMayBeUntrusted} is true.
 */
async function loadRepoTrustedLayer(
  adapter: ForgeAdapter,
  event: ForgeEvent,
  configPathRel: string,
): Promise<CrabdConfigPartial | undefined> {
  const source = await adapter.readOrgConfig(event.repo.slug, configPathRel);
  if (!source) {
    log(`no default-branch ${configPathRel} found for ${event.repo.slug}; this pull request run falls through to the org and default layers.`);
    return undefined;
  }

  try {
    return parseConfigYaml(source);
  } catch (error) {
    log(
      `default-branch ${configPathRel} could not be parsed, ignoring the repository layer for this run: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Resolve the layered config for this run:
 * built-in defaults → org config repo → the repository's own `.crabd.yml` → CI inputs → env, with
 * org-locked keys and full-override gating handled by {@link resolveConfig}.
 *
 * The repository layer is read from the checkout, except on a pull request whose head is not the
 * default branch, where it is fetched from the default branch and the checkout's copy is ignored.
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

  // Repo layer: the repository's own `.crabd.yml`, from the checkout unless a contributor controls it.
  const repoConfigPathRel = env.CRABD_CONFIG_PATH ?? '.crabd.yml';
  const repoConfigFile = join(cwd, repoConfigPathRel);
  const checkoutHasConfig = existsSync(repoConfigFile);
  const untrustedCheckout = checkoutMayBeUntrusted(event);

  let repo: CrabdConfigPartial | undefined;
  let repoTrusted: CrabdConfigPartial | undefined;
  if (untrustedCheckout) {
    repoTrusted = await loadRepoTrustedLayer(adapter, event, repoConfigPathRel);
    if (checkoutHasConfig) {
      log(`${repoConfigPathRel} in this checkout belongs to the pull request head, so it is ignored; the repository layer comes from ${event.repo.defaultBranch}.`);
    }
  } else if (checkoutHasConfig) {
    repo = parseConfigYaml(readFileSync(repoConfigFile, 'utf-8'));
  }

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

  // The extension is real code, loaded into this process, which holds the write-capable forge
  // token. A pull request head may not supply it for the run that reviews it.
  const extensionFile = join(cwd, env.CRABD_EXTENSION_PATH_REL ?? 'crabd.config.ts');
  const hasExtension = existsSync(extensionFile);
  if (hasExtension && untrustedCheckout) {
    log(`${env.CRABD_EXTENSION_PATH_REL ?? 'crabd.config.ts'} in this checkout belongs to the pull request head, so it is not loaded.`);
  }
  const extensionPath = hasExtension && !untrustedCheckout ? extensionFile : undefined;

  return { config, ...(extensionPath ? { extensionPath } : {}) };
}

#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCrabdExtension } from '@crabd/config';
import {
  finalizeRun,
  parseGitHubEvent,
  prepareRun,
  registerBuiltinModes,
  registerMode,
  renderRateLimitExhausted,
  reportRunError,
  type ForgeEvent,
  type ModeDefinition,
} from '@crabd/core';
import { loadResolvedConfig } from './config-loader.ts';
import { buildForge, detectForge } from './forge-factory.ts';

const ACTION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function log(message: string): void {
  process.stderr.write(`[crabd] ${message}\n`);
}

/**
 * Locate the flue CLI entry so we can run the model turn as a one-shot subprocess.
 * `@flue/cli` only exposes `./config` (ESM-only, no `require` condition), so we use
 * `import.meta.resolve` — not `require.resolve` — then walk up to the package root
 * to read its `bin`.
 */
function flueCliEntry(): string {
  const resolver = import.meta as unknown as { resolve(specifier: string): string };
  const configEntry = fileURLToPath(resolver.resolve('@flue/cli/config'));
  let dir = dirname(configEntry);
  for (let i = 0; i < 12 && dir !== dirname(dir); i++) {
    const pkgFile = join(dir, 'package.json');
    if (existsSync(pkgFile)) {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf-8')) as {
        name?: string;
        bin?: Record<string, string> | string;
      };
      if (pkg.name === '@flue/cli' && pkg.bin) {
        const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.flue;
        if (bin) return join(dir, bin);
      }
    }
    dir = dirname(dir);
  }
  throw new Error('crabd: could not locate the flue CLI entry');
}

/** Extract image URLs from markdown (`![](url)`) and bare image links in text. */
function extractImageUrls(...texts: (string | undefined)[]): string[] {
  const urls = new Set<string>();
  const md = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
  const bare = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp))/gi;
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(md)) if (m[1]) urls.add(m[1]);
    for (const m of text.matchAll(bare)) if (m[1]) urls.add(m[1]);
  }
  return [...urls].slice(0, 8);
}

/**
 * The discriminated result the crabd-turn workflow prints on stdout: a success
 * (carrying the mode's structured `data` + which model produced it), or an
 * in-scope rate-limit exhaustion. Any other (fatal) failure throws from the
 * subprocess instead and is handled by the generic error path.
 */
type CrabdTurnResult =
  | { ok: true; data: unknown; meta?: { modelUsed?: string; fellBackFrom?: string } }
  | { ok: false; error: { kind: string; message: string; attempts: number; lastModel?: string } };

/** Run `flue run workflow:crabd-turn` once and return the parsed structured result. */
function runFlueTurn(mode: string, message: string, images: string[]): CrabdTurnResult {
  const input = JSON.stringify({ mode, message, images });
  const stdout = execFileSync(
    process.execPath,
    [flueCliEntry(), 'run', 'workflow:crabd-turn', '--input', input],
    { cwd: ACTION_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024 },
  );
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('crabd: the model turn produced no result');
  return JSON.parse(trimmed) as CrabdTurnResult;
}

/**
 * Exhaustion behavior when every model in the chain was rate-limited: an explicit
 * `on_exhausted` config wins; otherwise the per-mode default — `review` soft-finishes
 * (green, so a transient limit doesn't block PRs), other modes fail the check.
 */
function exhaustionIsSoft(config: { rateLimit: { onExhausted?: 'soft' | 'fail' } }, mode: string): boolean {
  const decision = config.rateLimit.onExhausted ?? (mode === 'review' ? 'soft' : 'fail');
  return decision === 'soft';
}

/** Emit a GitHub/Forgejo Actions output value. */
function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `crabd_${name}_${Math.abs(hashCode(value))}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

async function registerExtensionModes(extensionPath: string | undefined, cwd: string): Promise<void> {
  if (!extensionPath) return;
  const extension = await loadCrabdExtension(extensionPath, cwd);
  for (const mode of (extension?.modes ?? []) as ModeDefinition[]) {
    if (mode && typeof mode.name === 'string') registerMode(mode);
  }
}

async function main(): Promise<number> {
  registerBuiltinModes();

  const eventName = process.env.CRABD_EVENT_NAME ?? process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.CRABD_EVENT_PATH ?? process.env.GITHUB_EVENT_PATH;
  if (!eventName || !eventPath) {
    log('no event (GITHUB_EVENT_NAME / GITHUB_EVENT_PATH). Nothing to do.');
    return 0;
  }

  const forge = detectForge();
  const payload = JSON.parse(readFileSync(eventPath, 'utf-8')) as unknown;
  const event: ForgeEvent | null = parseGitHubEvent(eventName, payload, forge);
  if (!event) {
    log(`event "${eventName}" is not handled. Skipping.`);
    return 0;
  }

  const cwd = process.env.GITHUB_WORKSPACE ?? process.cwd();
  const { adapter, auth } = buildForge(forge, event.repo);

  const { config, extensionPath } = await loadResolvedConfig({ adapter, event, cwd });
  await registerExtensionModes(extensionPath, cwd);

  const outcome = await prepareRun({ adapter, config, event });
  if (outcome.status === 'skip') {
    log(`skip: ${outcome.reason}`);
    return 0;
  }
  if (outcome.status === 'denied') {
    log(`denied: ${outcome.reason}`);
    return 0;
  }

  const { plan, context, trigger } = outcome;
  log(`mode=${plan.mode} model=${plan.model} subject=#${plan.subject}`);

  // Hand the resolved dials to the Flue turn via env. max_turns is a HARD ceiling
  // enforced inside the turn (abort on tool-call count) — deliberately NOT injected
  // into the prompt, so the model isn't biased into finishing early.
  process.env.CRABD_MODEL = plan.model;
  process.env.CRABD_THINKING_LEVEL = plan.thinkingLevel;
  process.env.CRABD_INSTRUCTIONS = plan.instructions;
  process.env.CRABD_CWD = cwd;
  if (config.limits.maxTurns) process.env.CRABD_MAX_TURNS = String(config.limits.maxTurns);
  if (extensionPath) process.env.CRABD_EXTENSION_PATH = extensionPath;
  if (config.providers.custom.length > 0) {
    process.env.CRABD_CUSTOM_PROVIDERS = JSON.stringify(config.providers.custom);
  }
  // Egress gateway: route allowlisted built-in providers through `${gateway}/<provider>`.
  // Custom providers (own base_url) and ollama are excluded.
  if (config.providers.gatewayUrl) {
    const customIds = new Set(config.providers.custom.map((p) => p.id));
    const gatewayProviders = config.providers.allowlist.filter((id) => !customIds.has(id) && id !== 'ollama');
    if (gatewayProviders.length > 0) {
      process.env.CRABD_GATEWAY_URL = config.providers.gatewayUrl;
      process.env.CRABD_GATEWAY_PROVIDERS = JSON.stringify(gatewayProviders);
    }
  }
  if (config.mcp.length > 0) process.env.CRABD_MCP = JSON.stringify(config.mcp);
  process.env.CRABD_WEB_SEARCH = JSON.stringify(config.webSearch);
  // Branding for the comments the turn subprocess posts (progress + rate-limit updates).
  process.env.CRABD_BRANDING = JSON.stringify(config.appearance);
  // Rate-limit dials (backoff, fallback chain, wait budget). The turn subprocess
  // does the retry/fallback; on_exhausted is applied here (it needs the mode).
  process.env.CRABD_RATE_LIMIT = JSON.stringify(config.rateLimit);
  if (config.limits.timeoutMinutes) {
    process.env.CRABD_TIMEOUT_MS = String(Math.round(config.limits.timeoutMinutes * 60_000));
  }

  // Wire the live-progress tool: the turn subprocess needs a token + the tracking
  // comment reference to post updates as it works.
  try {
    process.env.CRABD_FORGE_TOKEN = await auth.getToken();
    process.env.CRABD_REPO_OWNER = event.repo.owner;
    process.env.CRABD_REPO_NAME = event.repo.name;
    process.env.CRABD_REPO_DEFAULT_BRANCH = event.repo.defaultBranch;
    process.env.CRABD_TRACKING_ID = String(plan.tracking.id);
    process.env.CRABD_SUBJECT = String(plan.subject);
  } catch (error) {
    // Progress updates are best-effort; a token failure here shouldn't block the run.
    log(`progress tool disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  const images = extractImageUrls(event.comment?.body, context.issue?.body, context.pullRequest?.body);

  let turn: CrabdTurnResult;
  try {
    turn = runFlueTurn(plan.mode, plan.message, images);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`model turn failed: ${message}`);
    await reportRunError(adapter, plan, message);
    return 1;
  }

  // Every model in the chain was rate-limited (or the wait budget ran out). Apply the
  // per-mode exhaustion policy: soft-finish green, or fail the check.
  if (!turn.ok) {
    const soft = exhaustionIsSoft(config, plan.mode);
    log(`rate-limited: exhausted after ${turn.error.attempts} attempt(s); ${soft ? 'soft-finishing' : 'failing check'}`);
    await adapter.updateTrackingComment(
      plan.tracking,
      renderRateLimitExhausted(plan.branding, {
        mode: plan.mode,
        attempts: turn.error.attempts,
        ...(turn.error.lastModel ? { lastModel: turn.error.lastModel } : {}),
        soft,
        triggerPhrase: config.triggerPhrase,
      }),
    );
    return soft ? 0 : 1;
  }

  const data = turn.data;
  const note =
    turn.meta?.fellBackFrom && turn.meta.modelUsed
      ? `Primary model \`${turn.meta.fellBackFrom}\` was rate-limited — completed with \`${turn.meta.modelUsed}\`.`
      : undefined;

  const result = await finalizeRun({ adapter, config, event, context, trigger, plan, data, cwd, ...(note ? { note } : {}) });

  setOutput('mode', plan.mode);
  setOutput('result', JSON.stringify(data));
  setOutput('summary', result.summary);
  log('done.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });

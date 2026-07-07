#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  type ClassifyRequest,
  type FailureKind,
  type ForgeEvent,
  type ModeDefinition,
} from '@crabd/core';
import { loadResolvedConfig } from './config-loader.ts';
import { buildForge, detectForge } from './forge-factory.ts';
import { forgeHost, gitCredentialEnv, renderNpmrc, scopedRepoNames } from './sandbox.ts';

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
  | { ok: true; data: unknown; meta?: { modelUsed?: string; fellBackFrom?: string; partial?: boolean } }
  | {
      ok: false;
      error: {
        kind: string;
        message?: string;
        /** rate_limited only. */
        attempts?: number;
        lastModel?: string;
        /** max_turns only. */
        maxTurns?: number;
        /** timeout only. */
        timeoutMinutes?: number;
      };
    };

/** The Actions run URL, for a "run logs" link in comments (GitHub + Forgejo set these). */
function runUrlFromEnv(): string | undefined {
  const server = process.env.GITHUB_SERVER_URL;
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  return server && repo && runId ? `${server}/${repo}/actions/runs/${runId}` : undefined;
}

/** Failure kinds crab'd renders a tailored comment for; anything else falls back to `error`. */
const TAILORED_FAILURE_KINDS: readonly FailureKind[] = ['max_turns', 'timeout', 'config', 'network'];
function toFailureKind(kind: string): FailureKind {
  return (TAILORED_FAILURE_KINDS as readonly string[]).includes(kind) ? (kind as FailureKind) : 'error';
}

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
 * Classify a bare mention's intent with a cheap `crabd-classify` turn. Returns the chosen
 * mode, or `undefined` on any failure — the caller then keeps the default `mention`. This is
 * the `ClassifyFn` prepareRun calls; it runs a separate low-thinking, no-tools model pass.
 */
function runFlueClassify(request: ClassifyRequest): { mode: string } | undefined {
  try {
    const stdout = execFileSync(
      process.execPath,
      [flueCliEntry(), 'run', 'workflow:crabd-classify', '--input', JSON.stringify(request)],
      { cwd: ACTION_DIR, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024 },
    );
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const parsed = JSON.parse(trimmed) as { mode?: string };
    return parsed.mode ? { mode: parsed.mode } : undefined;
  } catch (error) {
    log(`classify failed, keeping mention: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Register the model providers with the Flue subprocesses via env (read by app.ts): user-defined
 * custom providers and any egress-gateway routing. Independent of the mode, so it is applied
 * before prepareRun — the classify pass needs it too, and it runs inside prepareRun.
 */
function applyProviderEnv(config: {
  providers: { custom: { id: string }[]; allowlist: string[]; gatewayUrl?: string | null };
}): void {
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
  const { adapter, auth, strategy } = buildForge(forge, event.repo);

  const { config, extensionPath } = await loadResolvedConfig({ adapter, event, cwd });
  await registerExtensionModes(extensionPath, cwd);

  // Multi-repo read needs a cross-repo-capable token. The broker vends single-repo tokens by
  // design, so ignore repos.read under it — keeping the prompt honest (no false GH_TOKEN claim).
  if (strategy === 'broker' && config.repos.read !== undefined) {
    log('repos.read is set but the token broker only vends single-repo tokens — ignoring. Use your own App (CRABD_APP_*) or a scoped PAT for cross-repo access.');
    delete config.repos.read;
  }

  // Wiring the classify pass needs before prepareRun runs it: providers must be registered so
  // the subprocess can reach the model, the model to use (the primary — the main turn overwrites
  // CRABD_MODEL below with the per-mode model), and the checkout for its sandbox.
  applyProviderEnv(config);
  process.env.CRABD_MODEL = config.model;
  process.env.CRABD_CWD = cwd;

  const outcome = await prepareRun({ adapter, config, event, cwd, classify: async (req) => runFlueClassify(req) });
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
  // Provider registration env (custom providers + egress gateway) was already applied before
  // prepareRun (the classify pass needs it) — see applyProviderEnv above.
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

  // --- Sandbox access: cross-repo read token, forwarded secrets, private-registry .npmrc ---
  // All opt-in via config. Anything placed here is visible to the model's (network-capable) shell.
  const sandboxEnv: Record<string, string> = {};

  // (a) Forward allowlisted env vars (values come from CI secrets mapped onto the crab'd step).
  for (const name of config.sandbox.env) {
    const value = process.env[name];
    if (value) sandboxEnv[name] = value;
    else log(`sandbox.env: "${name}" is not set in the environment — skipping`);
  }

  // (b) Cross-repo READ (or a GitHub Packages .npmrc with no explicit token): expose a
  //     read-only forge token so the model can `gh`/`git` other repos on demand.
  const npmrcNeedsForgeToken = config.sandbox.npmrc.some((r) => !r.tokenEnv);
  if (config.repos.read !== undefined || npmrcNeedsForgeToken) {
    try {
      let token: string | undefined;
      if (strategy === 'app' && typeof auth.mintScopedToken === 'function') {
        const names = scopedRepoNames(config.repos.read, event.repo.name);
        token = await auth.mintScopedToken(names ? { repositoryNames: names } : {});
      } else if (strategy === 'static') {
        token = await auth.getToken(); // scope is whatever the supplied token already has
      }
      if (token) {
        sandboxEnv.GH_TOKEN = token;
        // Preconfigure git so plain `git clone https://host/owner/repo` authenticates (forge-aware:
        // GitHub needs the `x-access-token` username, Forgejo takes the token itself).
        Object.assign(sandboxEnv, gitCredentialEnv(forge, forgeHost(process.env.GITHUB_SERVER_URL), token));
      }
    } catch (error) {
      log(`sandbox read token unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // (c) Private registries: forward any explicit token env-vars, write a managed .npmrc, and
  //     point npm/pnpm at it via NPM_CONFIG_USERCONFIG (never clobbering the repo's own .npmrc).
  if (config.sandbox.npmrc.length > 0) {
    for (const r of config.sandbox.npmrc) {
      if (r.tokenEnv && !(r.tokenEnv in sandboxEnv)) {
        const value = process.env[r.tokenEnv];
        if (value) sandboxEnv[r.tokenEnv] = value;
        else log(`sandbox.npmrc: token env "${r.tokenEnv}" is not set — the registry may fail to authenticate`);
      }
    }
    const npmrc = renderNpmrc(config.sandbox.npmrc, 'GH_TOKEN');
    if (npmrc) {
      const npmrcPath = join(tmpdir(), 'crabd.npmrc');
      writeFileSync(npmrcPath, npmrc, 'utf-8');
      sandboxEnv.NPM_CONFIG_USERCONFIG = npmrcPath;
    }
  }

  if (Object.keys(sandboxEnv).length > 0) {
    process.env.CRABD_SANDBOX_ENV = JSON.stringify(sandboxEnv);
  }

  const images = extractImageUrls(event.comment?.body, context.issue?.body, context.pullRequest?.body);

  const runUrl = runUrlFromEnv();

  let turn: CrabdTurnResult;
  try {
    turn = runFlueTurn(plan.mode, plan.message, images);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    log(`model turn failed: ${raw}`);
    // The turn normally returns fatal failures structured (see below); this path is only a
    // hard subprocess crash. execFileSync reports "Command failed: <full command + serialized
    // prompt>" — never post that; the real cause is in the run logs (stderr is inherited there).
    const detail = raw.startsWith('Command failed:') ? undefined : raw;
    await reportRunError(adapter, plan, {
      kind: 'error',
      ...(detail ? { detail } : {}),
      ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
      ...(runUrl ? { runUrl } : {}),
    });
    return 1;
  }

  if (!turn.ok) {
    // Every model in the chain was rate-limited (or the wait budget ran out). Apply the
    // per-mode exhaustion policy: soft-finish green, or fail the check.
    if (turn.error.kind === 'rate_limited') {
      const soft = exhaustionIsSoft(config, plan.mode);
      log(`rate-limited: exhausted after ${turn.error.attempts ?? 0} attempt(s); ${soft ? 'soft-finishing' : 'failing check'}`);
      await adapter.updateTrackingComment(
        plan.tracking,
        renderRateLimitExhausted(plan.branding, {
          mode: plan.mode,
          attempts: turn.error.attempts ?? 0,
          ...(turn.error.lastModel ? { lastModel: turn.error.lastModel } : {}),
          soft,
          triggerPhrase: config.triggerPhrase,
        }),
      );
      return soft ? 0 : 1;
    }

    // Any other terminal failure (max_turns, timeout, or an unexpected error): post a
    // helpful, kind-specific comment with a cause, what to change, and a docs link.
    log(`failed: ${turn.error.kind}${turn.error.message ? ` — ${turn.error.message}` : ''}`);
    await reportRunError(adapter, plan, {
      kind: toFailureKind(turn.error.kind),
      ...(turn.error.message ? { detail: turn.error.message } : {}),
      ...(turn.error.maxTurns ? { maxTurns: turn.error.maxTurns } : {}),
      ...(turn.error.timeoutMinutes ? { timeoutMinutes: turn.error.timeoutMinutes } : {}),
      ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
      ...(runUrl ? { runUrl } : {}),
    });
    return 1;
  }

  const data = turn.data;
  const notes: string[] = [];
  if (turn.meta?.fellBackFrom && turn.meta.modelUsed) {
    notes.push(`Primary model \`${turn.meta.fellBackFrom}\` was rate-limited — completed with \`${turn.meta.modelUsed}\`.`);
  }
  if (turn.meta?.partial) {
    notes.push('Reached the step limit before finishing — this is a partial answer. Narrow the request or raise `limits.max_turns` for a complete run.');
  }
  const note = notes.length > 0 ? notes.join(' ') : undefined;

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

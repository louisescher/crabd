#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '@flue/runtime';
import { start } from '@flue/runtime/node';
import {
  loadCrabdExtension,
  type ResolvedConfig,
  type ResolvedRateLimit,
} from '@crabd/config';
import {
  describeCommentableLines,
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
import { buildClassifyMessage, CrabdClassify, type ClassifyCreation } from './agents/crabd-classify.ts';
import { CrabdRefuter } from './agents/crabd-refuter.ts';
import { CrabdTurn } from './agents/crabd-turn.ts';
import { loadResolvedConfig } from './config-loader.ts';
import { buildForge, detectForge } from './forge-factory.ts';
import { buildProviders, unsizedCustomModels } from './providers.ts';
import {
  buildRunContext,
  recordedMemories,
  runContext,
  setRunContext,
  type ProgressTarget,
} from './run-context.ts';
import { runTurn } from './turn-runner.ts';
import {
  forgeHost,
  gitCredentialEnv,
  type NpmrcAuthStatus,
  renderNpmrc,
  renderNpmrcAdvisory,
  scopedRepoNames,
} from './sandbox.ts';

function log(message: string): void {
  process.stderr.write(`[crabd] ${message}\n`);
}

/**
 * Like {@link log}, but also surfaces the message as a GitHub Actions warning annotation (visible in
 * the run summary, not just buried in the step log) when running under Actions.
 */
function warn(message: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning::[crabd] ${message}\n`);
  process.stderr.write(`[crabd] ${message}\n`);
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
 * The discriminated result of one turn: a success (carrying the mode's structured `data` + which
 * model produced it), or an in-scope rate-limit exhaustion. Any other (fatal) failure throws
 * instead and is handled by the generic error path.
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

/** What a mode needs to run its semantic self-check. See `ValidateContext`. */
interface TurnValidation {
  changedPaths: string[];
  anchorable: { path: string; ranges: string[] }[];
}

/** Run one crab'd turn in this process and return its structured result. */
async function runCrabdTurn(
  mode: string,
  message: string,
  instructions: string,
  model: string,
  images: string[],
  validation: TurnValidation | undefined,
  rateLimit: ResolvedRateLimit,
): Promise<CrabdTurnResult> {
  const outcome = await runTurn(
    { mode, message, instructions, images, ...(validation ? { validation } : {}) },
    rateLimit,
    model,
  );
  return outcome as unknown as CrabdTurnResult;
}

/**
 * Classify a bare mention's intent with a cheap `crabd-classify` turn. Returns the chosen
 * mode, or `undefined` on any failure — the caller then keeps the default `mention`. This is
 * the `ClassifyFn` prepareRun calls; it runs a separate low-thinking, no-tools model pass.
 */
async function runCrabdClassify(request: ClassifyRequest): Promise<{ mode: string } | undefined> {
  try {
    const handle = init(CrabdClassify, { id: `${runContext().runId}-classify` });
    const receipt = await handle.dispatch({
      message: buildClassifyMessage(request),
      initialData: { candidates: request.candidates, model: classifyModel } satisfies ClassifyCreation,
    });
    const reply = await handle.read(receipt);
    const picked = (reply.data?.mode?.at(-1) as { mode?: string } | undefined)?.mode;
    return picked ? { mode: picked } : undefined;
  } catch (error) {
    log(`classify failed, keeping mention: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Boot the agent runtime in this process.
 *
 * The turn used to run as a `flue run` subprocess, which is why so much of the configuration was
 * serialized into `CRABD_*` env vars. `start()` mirrors what a built server does at boot with no HTTP
 * surface, so the turn is now a function call and the providers are real objects rather than JSON.
 */
async function startRuntime(config: ResolvedConfig): Promise<{ stop(): Promise<void> }> {
  const providers = buildProviders(config);
  return await start({
    agents: [CrabdTurn, CrabdClassify, CrabdRefuter],
    ...(providers ? { providers } : {}),
  });
}

/**
 * Warn when a model runs on a custom provider that declares no `context_window`.
 *
 * An unknown window is treated as zero, which has two silent consequences: context compaction fires
 * on every turn, and the per-request output cap collapses to a single token — the model then emits one
 * reasoning token, never calls a tool, and the turn fails with nothing that points back here.
 */
function warnUnsizedCustomProviders(config: ResolvedConfig): void {
  for (const spec of unsizedCustomModels(config)) {
    warn(
      `model ${spec} runs on a custom provider with no context_window — its context window is treated ` +
        'as unknown, which compacts on every turn and caps each response at one output token. Set ' +
        'that provider\'s context_window to the window your endpoint serves.',
    );
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

let runtime: { stop(): Promise<void> } | undefined;
/** The model the classify pass uses: the config default, before a per-mode override applies. */
let classifyModel = 'anthropic/claude-haiku-4-5';

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

  // Warnings raised before the run that belong on the tracking comment rather than only in the log:
  // a setting the user turned on that cannot take effect here. Threaded through prepareRun so they
  // appear from the very first "working..." update instead of at the end.
  const advisories: string[] = [];

  // A token that cannot write makes every write path a 403 at the end of the run, after the model
  // has already done the work. Ask the token what it can do and turn writes off up front, so the
  // agent is told before it starts and answers instead of committing.
  //
  // Memory recording needs the same answer, so the introspection runs when either is on.
  const memoryWants = config.memory.enabled && config.memory.write !== 'off';
  if (config.permissions.write || memoryWants) {
    try {
      const granted = await auth.tokenPermissions?.();
      // `undefined` means the strategy cannot know (a PAT or workflow token carries no
      // introspectable scope) — never that access is missing. Treating unknown as "no access" would
      // put a false "crab'd can't write here" on every PAT install. See AuthProvider.tokenPermissions.
      if (granted && granted.contents !== 'write') {
        if (config.permissions.write) {
          warn(
            `the ${forge === 'github' ? 'GitHub App installation' : 'token'} for this repository grants \`contents: ${granted.contents ?? 'none'}\`, so crab'd cannot commit here and is running read-only. Grant contents write access (and accept the permission request on the installation) to let it commit.`,
          );
        }
        if (memoryWants) {
          advisories.push(
            `Memory recording is on, but crab'd's ${forge === 'github' ? 'GitHub App installation' : 'token'} grants \`contents: ${granted.contents ?? 'none'}\` for this repository, so nothing will be recorded. Grant contents write access, or set \`memory.write: off\`.`,
          );
        }
        config.permissions.write = false;
      }
    } catch (error) {
      // Unknowable scope is not a reason to refuse to run: keep the configured posture and let a
      // genuine write failure surface as it did before.
      log(`could not read token permissions, keeping configured write access: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Multi-repo read needs a cross-repo-capable token. The broker vends single-repo tokens by
  // design, so ignore repos.read under it — keeping the prompt honest (no false GH_TOKEN claim).
  if (strategy === 'broker' && config.repos.read !== undefined) {
    log('repos.read is set but the token broker only vends single-repo tokens — ignoring. Use your own App (CRABD_APP_*) or a scoped PAT for cross-repo access.');
    delete config.repos.read;
  }

  // Wiring the classify pass needs before prepareRun runs it: the runtime (so the model is reachable),
  // the model to use (the primary — the main turn overwrites CRABD_MODEL below with the per-mode
  // model), and the checkout for its sandbox.
  warnUnsizedCustomProviders(config);
  // The classify pass runs inside prepareRun, so both the context and the runtime have to exist by
  // now. The turn re-installs the context below with the plan's per-mode dials.
  setRunContext(buildRunContext({ config, cwd, runId: `crabd-${event.repo.name}-classify` }));
  classifyModel = config.model;
  runtime = await startRuntime(config);

  const outcome = await prepareRun({
    adapter,
    config,
    event,
    cwd,
    advisories,
    classify: async (req) => runCrabdClassify(req),
  });
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
  const runUrl = runUrlFromEnv();

  // A checkout that isn't the PR head means the agent reads the wrong version of every file it
  // opens. prepareRun already tried to correct it and told the model; make it loud in CI too,
  // because the fix is in the consumer's workflow file, not in crab'd.
  if (plan.workspace?.matchesPrHead === false) {
    const where = `HEAD ${plan.workspace.headSha ?? 'unknown'}, PR head ${plan.workspace.expectedHeadSha ?? 'unknown'}`;
    // A merge-ref checkout still contains the change, so it's a note, not a warning.
    if (plan.workspace.containsPrHead) {
      log(`checkout is a merge of this pull request into its base rather than its head (${where}); the changes are present`);
    } else {
      warn(
        `the checkout is not this pull request's head (${where}) and could not be moved onto it, so the review will be based on the diff alone. Set an explicit \`ref:\` on actions/checkout for comment triggers (see workflows/github/crabd.yml).`,
      );
    }
  }

  // The resolved dials for this turn. max_turns is a HARD ceiling enforced by the runner (abort on
  // tool-call count) — deliberately NOT injected into the prompt, so the model isn't biased into
  // finishing early.
  let diffPath: string | undefined;
  // The opt-in refutation pass needs the diff to know what changed. It goes via a temp file rather
  // than the prompt because every refuter reads the same bytes and the prompt already carries plenty.
  if (config.review.verify.enabled && plan.mode === 'review' && context.diff) {
    try {
      diffPath = join(tmpdir(), `crabd-diff-${plan.subject}.patch`);
      writeFileSync(diffPath, context.diff, 'utf-8');
    } catch (error) {
      diffPath = undefined;
      log(`review.verify: could not stage the diff, refuters will work from file contents only: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The live-progress tool needs a token + the tracking comment reference to post updates as it works.
  let progress: ProgressTarget | undefined;
  let forgeToken: string | undefined;
  try {
    forgeToken = await auth.getToken();
    progress = { adapter, tracking: plan.tracking };
  } catch (error) {
    // Progress updates are best-effort; a token failure here shouldn't block the run.
    log(`progress tool disabled: ${error instanceof Error ? error.message : String(error)}`);
  }

  // The mode's instructions, which the npmrc advisory below may append to.
  let turnInstructions = plan.instructions;

  // --- Sandbox access: cross-repo read token, forwarded secrets, private-registry .npmrc ---
  // All opt-in via config. Anything placed here is visible to the model's (network-capable) shell.
  const sandboxEnv: Record<string, string> = {};

  // (a) Forward allowlisted env vars (values come from CI secrets mapped onto the crab'd step).
  for (const name of config.sandbox.env) {
    const value = process.env[name];
    if (value) sandboxEnv[name] = value;
    else log(`sandbox.env: "${name}" is not set in the environment — skipping`);
  }

  // (b) An explicit repos.read list is a promise baked into the agent's prompt ("you have
  //     GH_TOKEN read access to these repos" — see environmentNote in assemble.ts). If the
  //     credential crab'd is actually running as can't reach one of them, that isn't something
  //     to continue past silently: fail the run now, naming the repo, instead of leaving the
  //     agent to discover a missing/useless token mid-run. Skipped for `'all'` or a glob entry —
  //     neither is enumerable.
  if (Array.isArray(config.repos.read) && !config.repos.read.some((r) => r.includes('*'))) {
    const denied: string[] = [];
    for (const slug of config.repos.read) {
      try {
        if ((await adapter.checkRepoAccess(slug)) === 'denied') denied.push(slug);
      } catch (error) {
        log(`repos.read: could not verify access to "${slug}", continuing: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (denied.length > 0) {
      const plural = denied.length > 1;
      const who = forge === 'github' ? 'the GitHub App installation' : "crab'd's Forgejo bot account";
      const fix = forge === 'github' ? 'add the repo(s) to the App installation' : 'add the bot account as a member/collaborator there';
      log(`repos.read: no access to ${denied.join(', ')} — failing the run`);
      await reportRunError(adapter, plan, {
        kind: 'config',
        detail: `\`repos.read\` lists ${denied.map((d) => `\`${d}\``).join(', ')}, but ${who} cannot access ${plural ? 'them' : 'it'}. Either ${fix}, or remove ${plural ? 'them' : 'it'} from \`repos.read\`.`,
        ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
        ...(runUrl ? { runUrl } : {}),
      });
      return 1;
    }
  }

  // (c) Cross-repo READ (or a GitHub Packages .npmrc with no explicit token): expose a
  //     read-only forge token so the model can `gh`/`git` other repos on demand.
  const npmrcNeedsForgeToken = config.sandbox.npmrc.some((r) => !r.tokenEnv);
  if (config.repos.read !== undefined || npmrcNeedsForgeToken) {
    try {
      let token: string | undefined;
      if (strategy === 'app' && typeof auth.mintScopedToken === 'function') {
        const names = scopedRepoNames(config.repos.read, event.repo.name);
        token = await auth.mintScopedToken({
          ...(names ? { repositoryNames: names } : {}),
          // A .npmrc entry with no token_env authenticates GitHub Packages via this token.
          ...(npmrcNeedsForgeToken ? { packagesRead: true } : {}),
        });
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

  // (d) Private registries: forward any explicit token env-vars, write a managed .npmrc, point
  //     npm/pnpm at it via NPM_CONFIG_USERCONFIG (never clobbering the repo's own .npmrc), and tell
  //     the agent which registries are usable so it doesn't burn its budget on installs that 401/403.
  if (config.sandbox.npmrc.length > 0) {
    const authStatuses: NpmrcAuthStatus[] = [];
    for (const r of config.sandbox.npmrc) {
      if (r.tokenEnv && !(r.tokenEnv in sandboxEnv)) {
        const value = process.env[r.tokenEnv];
        if (value) sandboxEnv[r.tokenEnv] = value;
        else warn(`sandbox.npmrc: token env "${r.tokenEnv}" is not set — ${r.registry} will not authenticate; map it onto the crab'd step from a CI secret`);
      }
      // Authed when the token this entry references is present: an explicit tokenEnv value, or the
      // GH_TOKEN forge-token fallback from block (b) (only set under the app/static strategies).
      const authed = r.tokenEnv ? Boolean(sandboxEnv[r.tokenEnv]) : Boolean(sandboxEnv.GH_TOKEN);
      if (!authed && !r.tokenEnv) {
        warn(`sandbox.npmrc: ${r.registry} relies on the forge token but none was exposed — the forge-token fallback needs the GitHub App strategy or an explicit token_env (broker-minted tokens are not packages-scoped)`);
      }
      authStatuses.push({ ...r, authed });
    }
    const npmrc = renderNpmrc(config.sandbox.npmrc, 'GH_TOKEN');
    if (npmrc) {
      const npmrcPath = join(tmpdir(), 'crabd.npmrc');
      writeFileSync(npmrcPath, npmrc, 'utf-8');
      sandboxEnv.NPM_CONFIG_USERCONFIG = npmrcPath;
    }
    // Appended to the mode's instructions, not overwriting them.
    const advisory = renderNpmrcAdvisory(authStatuses);
    if (advisory) turnInstructions = `${turnInstructions}\n\n${advisory}`.trim();
  }

  // Everything the agents and the runner read about this run, in one place. The `CRABD_*` vars this
  // replaces existed only because the turn was a subprocess.
  setRunContext(
    buildRunContext({
      config,
      cwd,
      runId: `crabd-${plan.subject}-${plan.mode}`,
      thinkingLevel: plan.thinkingLevel,
      sandboxEnv,
      ...(forgeToken ? { forgeToken } : {}),
      repoSlug: event.repo.slug,
      ...(diffPath ? { diffPath } : {}),
      ...(progress ? { progress } : {}),
      memory: plan.memory,
      today: new Date().toISOString().slice(0, 10),
      branding: plan.branding,
    }),
  );

  const images = extractImageUrls(event.comment?.body, context.issue?.body, context.pullRequest?.body);

  // Anchorable lines travel as compact ranges rather than a second copy of the diff: the turn
  // input is passed as a command-line argument, and the message already carries the diff plus the
  // changed files' contents, so duplicating it risks an oversized argv.
  const validation: TurnValidation = {
    changedPaths: context.changedFiles.map((f) => f.path),
    anchorable: context.diff ? describeCommentableLines(context.diff) : [],
  };

  let turn: CrabdTurnResult;
  try {
    turn = await runCrabdTurn(plan.mode, plan.message, turnInstructions, plan.model, images, validation, config.rateLimit);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    log(`model turn failed: ${raw}`);
    // The turn normally returns fatal failures structured (see below); this path is a throw that
    // escaped the runner — an unregistered mode, or the runtime failing to reach the model at all.
    const detail = raw;
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

  const result = await finalizeRun({
    adapter,
    config,
    event,
    context,
    trigger,
    plan,
    data,
    cwd,
    memories: recordedMemories(),
    ...(note ? { note } : {}),
  });

  setOutput('mode', plan.mode);
  setOutput('result', JSON.stringify(data));
  setOutput('summary', result.summary);
  log('done.');
  return 0;
}

main()
  .finally(async () => {
    // The agent runtime owns a durable submission coordinator and a SQLite handle; leaving them open
    // keeps the process alive after the work is done.
    await runtime?.stop().catch(() => {});
  })
  .then((code) => process.exit(code))
  .catch((error) => {
    log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exit(1);
  });

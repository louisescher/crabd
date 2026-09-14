#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
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
  getMode,
  registerBuiltinModes,
  registerMode,
  checkoutPrHead,
  renderRateLimitExhausted,
  reportRunError,
  resolveWorkspace,
  snapshotBaseline,
  stripCheckoutCredentials,
  type Baseline,
  type ClassifyRequest,
  type FailureKind,
  type ForgeAdapter,
  type ForgeContext,
  type ForgeEvent,
  type ModeDefinition,
  type WorkspaceState,
} from '@crabd/core';
import { buildClassifyMessage, CrabdClassify, type ClassifyCreation } from './agents/crabd-classify.ts';
import { implementPhase } from '@crabd/core';
import { CrabdRefuter } from './agents/crabd-refuter.ts';
import { CrabdTurn } from './agents/crabd-turn.ts';
import { loadResolvedConfig } from './config-loader.ts';
import { buildForge, detectForge } from './forge-factory.ts';
import { log, warn } from './logger.ts';
import { saveRunState, type RunState } from './run-state.ts';
import { buildProviders, unsizedCustomModels } from './providers.ts';
import {
  buildRunContext,
  recordedMemories,
  runContext,
  setRunContext,
  type BranchUpdateTarget,
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
        providerRetries?: number;
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
const TAILORED_FAILURE_KINDS: readonly FailureKind[] = [
  'max_turns',
  'timeout',
  'resource_exhausted',
  'config',
  'network',
];
function toFailureKind(kind: string): FailureKind {
  return (TAILORED_FAILURE_KINDS as readonly string[]).includes(kind) ? (kind as FailureKind) : 'error';
}

/** What a mode needs to run its semantic self-check. See `ValidateContext`. */
interface TurnValidation {
  changedPaths: string[];
  anchorable: { path: string; ranges: string[] }[];
  subjectKind?: 'issue' | 'pull_request';
  threadIds?: string[];
  verifyCommands?: string[];
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
  // flue's own default timeout is an hour, well above anything crab'd would pick, so this only tightens it.
  const timeoutMinutes = config.limits.timeoutMinutes;
  if (timeoutMinutes) CrabdTurn.durability = { timeoutMs: Math.round(timeoutMinutes * 60_000) + 60_000 };
  // File-backed rather than flue's default `:memory:`, so retried attempts don't all accumulate in
  // process memory over a long-running failover. `tmpdir()`, not `RUNNER_TEMP`: a container action
  // cannot see the latter.
  const db = sqlite(join(tmpdir(), `crabd-run-${process.pid}.sqlite`));
  return await start({
    agents: [CrabdTurn, CrabdClassify, CrabdRefuter],
    db,
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

/**
 * The handle `update_branch` works through, or `undefined` when this run has no branch it may
 * update. `apply` moves the checkout onto the new head and refreshes the baseline it reads, so a
 * later commit doesn't revert the merge or trip the branch-moved guard.
 */
function buildBranchUpdate(input: {
  adapter: ForgeAdapter;
  config: ResolvedConfig;
  context: ForgeContext;
  plan: { baseline: Baseline; subject: number; mode: string; workspace?: WorkspaceState };
  cwd: string;
  forgeToken: string | undefined;
  forge: string;
}): BranchUpdateTarget | undefined {
  const { adapter, config, context, plan, cwd, forgeToken, forge } = input;
  const pr = context.pullRequest;
  if (!pr || pr.fromFork || !config.permissions.write) return undefined;
  // A review does not touch the branch, and a merge commit appearing under one would be a
  // surprising thing for asking to be reviewed.
  if (getMode(plan.mode)?.writes === undefined) return undefined;

  // Checkout credentials were stripped already, so the fetch after an update needs the token directly.
  const gitEnv = forgeToken
    ? gitCredentialEnv(forge, forgeHost(process.env.GITHUB_SERVER_URL), forgeToken)
    : undefined;

  return {
    adapter,
    prNumber: pr.number,
    cwd,
    headSha: () => pr.headSha,
    baseline: () => plan.baseline,
    apply(headSha: string): boolean {
      if (!checkoutPrHead(cwd, headSha, plan.subject, gitEnv)) return false;
      plan.baseline = snapshotBaseline(cwd);
      plan.workspace = resolveWorkspace(cwd, headSha);
      pr.headSha = headSha;
      return true;
    },
  };
}

/** How long a dying run may spend trying to update its comment before it gives up and exits. */
const FATAL_REPORT_TIMEOUT_MS = 3_000;

/**
 * Set once the run has a tracking comment to post to. Module-scoped because the process-level
 * handlers below have no other way to reach it, and one process serves one run.
 */
let fatalReporter: ((detail: string) => Promise<void>) | undefined;

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

  // Computed up front so a comment posted from a catch block still carries the run link.
  const runUrl = runUrlFromEnv();

  const outcome = await prepareRun({
    adapter,
    config,
    event,
    cwd,
    advisories,
    ...(runUrl ? { runUrl } : {}),
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

  // Covers the ways out of this function that are not a return: a cancel, or a heap crash.
  const runState: RunState = {
    version: 1,
    forge,
    repo: event.repo,
    tracking: { id: plan.tracking.id, target: plan.tracking.target },
    subject: plan.subject,
    mode: plan.verbKey ?? plan.mode,
    branding: plan.branding,
    ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
    finalized: false,
  };
  saveRunState(runState);
  const finalized = (): void => saveRunState({ ...runState, finalized: true });

  fatalReporter = async (detail) => {
    await reportRunError(adapter, plan, {
      kind: 'crashed',
      detail,
      ...(config.triggerPhrase ? { triggerPhrase: config.triggerPhrase } : {}),
    });
    finalized();
  };

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

  // Take away the checkout's write credentials now that prepareRun is done with the fetches that needed them.
  stripCheckoutCredentials(cwd);

  // --- Sandbox access: cross-repo read token, forwarded secrets, private-registry .npmrc ---
  // All opt-in via config. Anything placed here is visible to the model's (network-capable) shell.
  const sandboxEnv: Record<string, string> = {};

  const sandboxBin = process.env.CRABD_SANDBOX_BIN;
  if (sandboxBin) sandboxEnv.PATH = `${sandboxBin}:${process.env.PATH ?? ''}`;
  else log('sandbox git guard is not installed (CRABD_SANDBOX_BIN is unset), the shell can run git directly');

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
      });
      finalized();
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
        warn(
          `repos.read with a static token exposes that token to the model's shell with whatever scope it already has. Use a GitHub App (\`app-id\`/\`app-private-key\`) so crab'd can mint a read-only token instead.`,
        );
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

  const branchUpdate = buildBranchUpdate({ adapter, config, context, plan, cwd, forgeToken, forge });

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
      ...(branchUpdate ? { branchUpdate } : {}),
      memory: plan.memory,
      today: new Date().toISOString().slice(0, 10),
      branding: plan.branding,
      verbKey: plan.verbKey,
    }),
  );

  const images = extractImageUrls(event.comment?.body, context.issue?.body, context.pullRequest?.body);

  // Anchorable lines travel as compact ranges rather than a second copy of the diff, and the
  // review threads as bare ids: this is re-read on every repair pass, and the message already
  // carries the diff, the changed files' contents and the conversations themselves.
  const validation: TurnValidation = {
    changedPaths: context.changedFiles.map((f) => f.path),
    anchorable: context.diff ? describeCommentableLines(context.diff) : [],
    subjectKind: implementPhase(context, event) === 'round' ? 'pull_request' : 'issue',
    ...(context.reviewThreads ? { threadIds: context.reviewThreads.map((thread) => thread.id) } : {}),
    ...(config.implement.verify.commands.length > 0
      ? { verifyCommands: config.implement.verify.commands }
      : {}),
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
    });
    finalized();
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
          mode: plan.verbKey,
          attempts: turn.error.attempts ?? 0,
          ...(turn.error.lastModel ? { lastModel: turn.error.lastModel } : {}),
          ...(turn.error.providerRetries ? { providerRetries: turn.error.providerRetries } : {}),
          soft,
          triggerPhrase: config.triggerPhrase,
        }),
      );
      finalized();
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
    });
    finalized();
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

  finalized();
  setOutput('mode', plan.mode);
  setOutput('result', JSON.stringify(data));
  setOutput('summary', result.summary);
  log('done.');
  return 0;
}

/**
 * Report a run that is about to die, then leave. Bounded, since the runner SIGKILLs a few seconds
 * after SIGTERM. Re-entrant calls are ignored so two signals cannot post twice.
 */
let reportingFatal = false;
async function onFatal(error: unknown): Promise<void> {
  if (reportingFatal) return;
  reportingFatal = true;
  log(`fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  if (fatalReporter) {
    const detail = error instanceof Error ? error.message : String(error);
    await Promise.race([
      fatalReporter(detail).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FATAL_REPORT_TIMEOUT_MS)),
    ]);
  }
  process.exit(1);
}

process.on('uncaughtException', (error) => void onFatal(error));
process.on('unhandledRejection', (reason) => void onFatal(reason));
process.on('SIGTERM', () => void onFatal(new Error('the job was cancelled or timed out (SIGTERM)')));
process.on('SIGINT', () => void onFatal(new Error('the run was interrupted (SIGINT)')));

main()
  .finally(async () => {
    // The agent runtime owns a durable submission coordinator and a SQLite handle; leaving them open
    // keeps the process alive after the work is done.
    await runtime?.stop().catch(() => {});
  })
  .then((code) => process.exit(code))
  .catch((error) => void onFatal(error));

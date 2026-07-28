import {
  connectMcpServer,
  defineAgent,
  defineAgentProfile,
  defineTool,
  defineWorkflow,
  observe,
  type JsonValue,
  type ToolDefinition,
} from '@flue/runtime';
import { readFileSync } from 'node:fs';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import {
  DEFAULT_BRANDING,
  ForgejoForge,
  GitHubForge,
  StaticTokenAuth,
  buildAttemptChain,
  buildRefuterPrompt,
  expandCommentableLines,
  getMode,
  REFUTER_INSTRUCTIONS,
  RefuterVerdictSchema,
  survivesRefutation,
  registerBuiltinModes,
  registerMode,
  renderProgress,
  renderRateLimited,
  runWithFallback,
  type Branding,
  type ForgeAdapter,
  type ForgeRepo,
  type ModeDefinition,
  type RefuterVerdict,
  type ReviewFinding,
  type ReviewOutput,
  type TrackingComment,
  type ValidateContext,
} from '@crabd/core';
import { loadCrabdExtension, providerOf, type ResolvedRateLimit } from '@crabd/config';
import { webSearchTools } from '../tools/websearch.ts';

registerBuiltinModes();

/** Sandbox env allowlist. Empty by default — nothing leaks to the model's bash tool. */
function sandboxEnv(): Record<string, string | undefined> {
  const raw = process.env.CRABD_SANDBOX_ENV;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

const timeoutMs = process.env.CRABD_TIMEOUT_MS ? Number(process.env.CRABD_TIMEOUT_MS) : undefined;

/**
 * The agent that runs one crab'd turn. All dials are supplied via env by the CLI
 * orchestrator (which resolved them from the layered config).
 */
/**
 * The blinded second-opinion specialist used by the opt-in verify stage. Declared as a subagent
 * profile so each refutation runs in its own child session — it must not inherit the reviewer's
 * conversation, or it would just agree with reasoning it can see. Note `instructions` is
 * profile-owned in `@flue/runtime` (an omitted field means none, never the parent's), while the
 * sandbox boundary is inherited, which is what gives it read access to the same checkout.
 */
const refuter = defineAgentProfile({
  name: 'refuter',
  description: 'Independently tries to refute a single code-review finding.',
  instructions: REFUTER_INSTRUCTIONS,
});

const agent = defineAgent(() => ({
  model: process.env.CRABD_MODEL ?? 'anthropic/claude-sonnet-4-6',
  instructions: process.env.CRABD_INSTRUCTIONS ?? '',
  ...(process.env.CRABD_THINKING_LEVEL ? { thinkingLevel: process.env.CRABD_THINKING_LEVEL as never } : {}),
  ...(timeoutMs && Number.isFinite(timeoutMs) ? { durability: { timeoutMs } } : {}),
  sandbox: local({ cwd: process.env.CRABD_CWD ?? process.cwd(), env: sandboxEnv() }),
  subagents: [refuter],
}));

/** Load any custom modes contributed by a consumer's `crabd.config.ts` in this process. */
async function ensureCustomModes(): Promise<void> {
  const path = process.env.CRABD_EXTENSION_PATH;
  if (!path) return;
  const extension = await loadCrabdExtension(path, process.env.CRABD_CWD ?? process.cwd());
  for (const mode of (extension?.modes ?? []) as ModeDefinition[]) {
    if (mode && typeof mode.name === 'string') registerMode(mode);
  }
}

/** Build a forge adapter + tracking ref for the live-progress tool, from env passed by the CLI. */
function progressTarget(): { adapter: ForgeAdapter; tracking: TrackingComment } | undefined {
  const token = process.env.CRABD_FORGE_TOKEN;
  const owner = process.env.CRABD_REPO_OWNER;
  const name = process.env.CRABD_REPO_NAME;
  const trackingId = process.env.CRABD_TRACKING_ID;
  const subject = process.env.CRABD_SUBJECT;
  if (!token || !owner || !name || !trackingId || !subject) return undefined;

  const repo: ForgeRepo = {
    owner,
    name,
    slug: `${owner}/${name}`,
    defaultBranch: process.env.CRABD_REPO_DEFAULT_BRANCH ?? 'main',
    isPrivate: true,
  };
  const adapter: ForgeAdapter =
    process.env.CRABD_FORGE === 'forgejo'
      ? new ForgejoForge({ auth: new StaticTokenAuth('forgejo', token), repo, baseUrl: process.env.CRABD_FORGEJO_API_URL ?? '' })
      : new GitHubForge({ auth: new StaticTokenAuth('github', token), repo });
  return { adapter, tracking: { id: Number(trackingId), target: Number(subject) } };
}

/** Branding (name/emoji/footer) the CLI resolved from `config.appearance`, passed via env. */
function brandingFromEnv(): Branding {
  const raw = process.env.CRABD_BRANDING;
  if (!raw) return DEFAULT_BRANDING;
  try {
    const parsed = JSON.parse(raw) as Partial<Branding>;
    return {
      name: typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name : DEFAULT_BRANDING.name,
      emoji: typeof parsed.emoji === 'string' ? parsed.emoji : DEFAULT_BRANDING.emoji,
      footer: typeof parsed.footer === 'boolean' ? parsed.footer : DEFAULT_BRANDING.footer,
    };
  } catch {
    return DEFAULT_BRANDING;
  }
}

/** A tool the agent calls to post progress to the tracking comment mid-run. */
function progressTool(
  branding: Branding,
  mode: string,
  target: { adapter: ForgeAdapter; tracking: TrackingComment } | undefined,
): ToolDefinition | undefined {
  if (!target) return undefined;
  return defineTool({
    name: 'report_progress',
    description: 'Post a short progress update to the tracking comment so humans can follow along. Use for meaningful milestones, not every step.',
    input: v.object({ message: v.string() }),
    async run({ input }) {
      try {
        await target.adapter.updateTrackingComment(target.tracking, renderProgress(branding, mode, input.message));
      } catch {
        // Progress updates are best-effort.
      }
      return { ok: true };
    },
  });
}

/** Connect configured MCP servers and adapt their tools. Unreachable servers are skipped. */
async function mcpTools(): Promise<ToolDefinition[]> {
  const raw = process.env.CRABD_MCP;
  if (!raw) return [];
  let servers: { name: string; url: string; transport?: 'streamable-http' | 'sse'; headers?: Record<string, string> }[];
  try {
    servers = JSON.parse(raw);
  } catch {
    return [];
  }
  const tools: ToolDefinition[] = [];
  for (const server of servers) {
    try {
      const connection = await connectMcpServer(server.name, {
        url: server.url,
        ...(server.transport ? { transport: server.transport } : {}),
        ...(server.headers ? { headers: server.headers } : {}),
      });
      tools.push(...connection.tools);
    } catch {
      // Skip a server we can't reach rather than failing the whole run.
    }
  }
  return tools;
}

/** Fetch image URLs into inline base64 images for a vision-capable model. */
async function fetchImages(urls: string[]): Promise<{ type: 'image'; data: string; mimeType: string }[]> {
  const token = process.env.CRABD_FORGE_TOKEN;
  const images: { type: 'image'; data: string; mimeType: string }[] = [];
  for (const url of urls) {
    try {
      const sameHostAsForge = token && /github|githubusercontent|forgejo/i.test(new URL(url).host);
      const res = await fetch(url, sameHostAsForge ? { headers: { Authorization: `Bearer ${token}` } } : {});
      if (!res.ok) continue;
      const mimeType = (res.headers.get('content-type') ?? 'image/png').split(';')[0] ?? 'image/png';
      if (!mimeType.startsWith('image/')) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      images.push({ type: 'image', data: buffer.toString('base64'), mimeType });
    } catch {
      // Skip unreadable images.
    }
  }
  return images;
}

/** Parse the resolved rate-limit config the CLI passes as `CRABD_RATE_LIMIT` (camelCase JSON). */
function rateLimitConfig(): ResolvedRateLimit {
  const fallback: ResolvedRateLimit = {
    fallbackModels: [],
    maxRetries: 4,
    maxWaitSeconds: 180,
    triggerScope: 'transient',
    backoff: { strategy: 'exponential', initialDelaySeconds: 2, maxDelaySeconds: 30, multiplier: 2, jitter: true },
  };
  const raw = process.env.CRABD_RATE_LIMIT;
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw) as Partial<ResolvedRateLimit>;
    return {
      ...fallback,
      ...parsed,
      fallbackModels: Array.isArray(parsed.fallbackModels) ? parsed.fallbackModels : [],
      backoff: { ...fallback.backoff, ...(parsed.backoff ?? {}) },
    };
  } catch {
    return fallback;
  }
}

/**
 * The resolved `review.verify` dials, passed as `CRABD_REVIEW_VERIFY`. Disabled when absent or
 * unparseable — a malformed value must not silently start spending on extra model calls.
 */
interface VerifyDials {
  enabled: boolean;
  minConfidence: number;
  maxConcurrency: number;
  model?: string;
}

function verifyConfig(): VerifyDials {
  const off: VerifyDials = { enabled: false, minConfidence: 7, maxConcurrency: 3 };
  const raw = process.env.CRABD_REVIEW_VERIFY;
  if (!raw) return off;
  try {
    const parsed = JSON.parse(raw) as Partial<VerifyDials>;
    return {
      enabled: parsed.enabled === true,
      minConfidence: typeof parsed.minConfidence === 'number' ? parsed.minConfidence : off.minConfidence,
      maxConcurrency:
        typeof parsed.maxConcurrency === 'number' && parsed.maxConcurrency >= 1
          ? Math.floor(parsed.maxConcurrency)
          : off.maxConcurrency,
      ...(typeof parsed.model === 'string' && parsed.model ? { model: parsed.model } : {}),
    };
  } catch {
    return off;
  }
}

/**
 * The pull request diff, read from the temp file the CLI wrote.
 *
 * Passed by path rather than by value because the turn input is a command-line argument and the
 * rendered message already carries a compressed diff plus the changed files' contents — a second
 * copy of the raw diff there risks an oversized argv. Only the verify stage needs it, so it is read
 * lazily and a failure just means refuters work from the file contents alone.
 */
function readDiff(): string | undefined {
  const path = process.env.CRABD_DIFF_PATH;
  if (!path) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. Preserves input order in the result. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Web-search / fetch tools, unless disabled via config (passed as CRABD_WEB_SEARCH). */
function configuredWebSearchTools(): ToolDefinition[] {
  const raw = process.env.CRABD_WEB_SEARCH;
  let cfg: { enabled?: boolean; maxResults?: number } = {};
  if (raw) {
    try {
      cfg = JSON.parse(raw);
    } catch {
      cfg = {};
    }
  }
  if (cfg.enabled === false) return [];
  return webSearchTools({ maxResults: cfg.maxResults ?? 5 });
}

/** How long the graceful wrap-up (final-answer) prompt may run before it's abandoned. */
const WRAP_UP_TIMEOUT_MS = 90_000;

/** How long a self-correction turn may run before the original answer is kept instead. */
const REPAIR_TIMEOUT_MS = 90_000;
/**
 * How many self-correction turns a mode may ask for. Two is enough for the mistakes this catches
 * (a mis-anchored line, a path outside the diff) and low enough that a model which keeps producing
 * the same invalid answer can't spin.
 */
const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Instruction for the wrap-up prompt. When a run reaches its soft tool-call budget, crab'd
 * asks the model to stop exploring and return its best structured answer from what it has
 * already gathered — so a run that would otherwise die at the hard ceiling with no output
 * instead posts a useful partial answer.
 */
const WRAP_UP_INSTRUCTION = [
  'You have reached the tool-call budget for this run and can no longer use tools — any further tool call will end the run immediately.',
  'Do not call any tools. Based only on what you have already gathered, produce your final structured answer now.',
  'If you could not fully complete the task, give your best partial answer: summarize what you found and verified, and clearly call out what remains unresolved. Name what is unresolved in terms of the code ("the callers of `parseLimit` are unchecked"), never in terms of this run, your budget, or your instructions. Since you can no longer make changes, set any "made changes" / edit flags to false.',
].join('\n');

/**
 * Map a fatal turn error into the structured failure the CLI renders a helpful comment from.
 * A deliberate max_turns abort is flagged explicitly; a durability timeout is detected by
 * message; everything else is a generic error. Never surfaces a raw stack trace to the user.
 */
function describeFatal(message: string, maxTurnsHit: boolean, maxTurns?: number): Record<string, JsonValue> {
  if (maxTurnsHit) return { kind: 'max_turns', message, ...(maxTurns ? { maxTurns } : {}) };
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out') || m.includes('durabilit')) {
    const minutes = timeoutMs && Number.isFinite(timeoutMs) ? Math.round(timeoutMs / 60_000) : undefined;
    return { kind: 'timeout', message, ...(minutes ? { timeoutMinutes: minutes } : {}) };
  }
  return { kind: 'error', message };
}

export default defineWorkflow({
  agent,
  input: v.object({
    mode: v.string(),
    message: v.string(),
    images: v.optional(v.array(v.string())),
    /**
     * What the mode needs to check its own output, in a form small enough to pass across the
     * process boundary — anchorable lines as compact ranges rather than the diff a second time.
     */
    validation: v.optional(
      v.object({
        changedPaths: v.array(v.string()),
        anchorable: v.array(v.object({ path: v.string(), ranges: v.array(v.string()) })),
      }),
    ),
  }),
  async run({ harness, input }) {
    await ensureCustomModes();
    const mode = getMode(input.mode);
    if (!mode) throw new Error(`crabd: no mode registered for "${input.mode}"`);

    const target = progressTarget();
    const brand = brandingFromEnv();
    const [connected, images] = await Promise.all([mcpTools(), fetchImages(input.images ?? [])]);
    const progress = progressTool(brand, input.mode, target);
    const tools = [...(progress ? [progress] : []), ...connected, ...configuredWebSearchTools()];

    const promptOptions = {
      result: mode.outputSchema,
      ...(tools.length > 0 ? { tools } : {}),
      ...(images.length > 0 ? { images } : {}),
    };

    // Rate-limit handling: walk the model chain (primary → fallbacks) once, applying
    // computed backoff between switches, bounded by a total wall-clock budget. The
    // framework already retries the *same* model internally before we ever see the
    // error, so crab'd's job here is to fall back to a *different* model, reflect the
    // state in the comment, and hand a clean exhaustion signal back to the CLI.
    const rl = rateLimitConfig();
    const primaryModel = process.env.CRABD_MODEL ?? 'anthropic/claude-sonnet-4-6';
    const chain = buildAttemptChain(primaryModel, rl.fallbackModels, rl.maxRetries);
    const maxWaitMs = Math.max(0, rl.maxWaitSeconds) * 1000;
    const maxTurns = process.env.CRABD_MAX_TURNS ? Number(process.env.CRABD_MAX_TURNS) : undefined;
    // Reserve a few turns at the end of the budget for a graceful wrap-up: crab'd stops
    // exploring at `softLimit` and spends the reserve asking the model for a final answer,
    // so reaching the ceiling yields a useful partial answer instead of a bare abort.
    const hasMaxTurns = !!(maxTurns && Number.isFinite(maxTurns) && maxTurns > 0);
    const wrapUpReserve = hasMaxTurns ? Math.min(4, Math.max(1, Math.floor(maxTurns! * 0.15))) : 0;
    const softLimit = hasMaxTurns ? Math.max(1, maxTurns! - wrapUpReserve) : 0;

    // Best-effort, throttled tracking-comment update while a model is being rate-limited.
    let lastRlUpdate = 0;
    const postRateLimited = (render: Parameters<typeof renderRateLimited>[1], force = false): void => {
      if (!target) return;
      const now = Date.now();
      if (!force && now - lastRlUpdate < 1500) return;
      lastRlUpdate = now;
      target.adapter.updateTrackingComment(target.tracking, renderRateLimited(brand, render)).catch(() => {});
    };

    // One observer for the whole run: the hard max_turns ceiling (reset per attempt)
    // plus surfacing the framework's own same-model retries into the tracking comment.
    let toolStarts = 0;
    let currentModel = primaryModel;
    let currentHandle: { abort: (reason?: unknown) => void } | undefined;
    let abortedForMaxTurns = false;
    let wrapUpRequested = false;
    const unsubscribe = observe((event) => {
      if (event.type === 'tool_start') {
        toolStarts += 1;
        if (!hasMaxTurns || !currentHandle) return;
        if (toolStarts > maxTurns!) {
          // Hard ceiling — abort for real.
          abortedForMaxTurns = true;
          currentHandle.abort(new Error(`crabd: max_turns (${maxTurns}) exceeded`));
        } else if (!wrapUpRequested && softLimit < maxTurns! && toolStarts > softLimit) {
          // Soft ceiling — stop exploring and spend the reserve on a final answer.
          wrapUpRequested = true;
          currentHandle.abort(new Error('crabd: wrap-up budget reached'));
        }
        return;
      }
      const e = event as unknown as { type: string; message?: string };
      if (e.type === 'log' && typeof e.message === 'string' && e.message.includes('flue:model-retry')) {
        postRateLimited({ mode: input.mode, provider: providerOf(currentModel), switching: false });
      }
    });

    // One attempt = one full model call (which itself includes the framework's
    // same-model retries). Fallback attempts use a fresh session so a failed turn
    // isn't carried into the retry's context.
    type TurnResult = { data: JsonValue; model?: string; partial?: boolean };

    // The mode's own semantic check on the answer, plus the context it needs. Absent when the CLI
    // supplied no validation payload or the mode has nothing to check.
    const validateContext: ValidateContext | undefined = input.validation
      ? {
          changedPaths: input.validation.changedPaths,
          anchorable: expandCommentableLines(input.validation.anchorable),
          cwd: process.env.CRABD_CWD ?? process.cwd(),
        }
      : undefined;

    /**
     * Give the model a bounded chance to fix an answer that is well-formed but unpostable — a
     * finding anchored outside every hunk, a path that isn't in the diff. Runs on the *same*
     * session so it still has everything it read, which is what makes this cheap. Entirely
     * best-effort: any failure keeps the answer we already have rather than losing the review.
     */
    const repair = async (
      session: Awaited<ReturnType<typeof harness.session>>,
      model: string,
      first: TurnResult,
    ): Promise<TurnResult> => {
      if (!mode.validate || !validateContext) return first;
      let current = first;

      for (let attempt = 0; attempt < MAX_REPAIR_ATTEMPTS; attempt++) {
        let verdict: ReturnType<NonNullable<typeof mode.validate>>;
        try {
          verdict = mode.validate(current.data, validateContext);
        } catch {
          // A broken validator must never cost us a review.
          return current;
        }
        if (verdict.ok) return current;

        try {
          const handle = session.prompt(verdict.repairPrompt, {
            ...promptOptions,
            model,
            signal: AbortSignal.timeout(REPAIR_TIMEOUT_MS),
          });
          currentHandle = handle;
          current = (await handle) as unknown as TurnResult;
        } catch {
          // Timed out, hit the turn ceiling, or the session refused — keep what we had. The
          // finalize path still demotes anything unpostable rather than dropping it.
          return current;
        }
      }
      return current;
    };

    // The session that produced the answer, kept so the verify stage can delegate from it.
    let lastSession: Awaited<ReturnType<typeof harness.session>> | undefined;

    const runOnce = async (model: string, index: number): Promise<TurnResult> => {
      currentModel = model;
      toolStarts = 0;
      abortedForMaxTurns = false;
      wrapUpRequested = false;
      const session = index === 0 ? await harness.session() : await harness.session(`crabd-fallback-${index}`);
      lastSession = session;
      const handle = session.prompt(input.message, { ...promptOptions, model });
      currentHandle = handle;
      try {
        return await repair(session, model, (await handle) as unknown as TurnResult);
      } catch (err) {
        // Soft budget hit (not the hard ceiling, not a rate limit): reuse the session's
        // conversation to ask for a best-effort final answer. Bounded by a timeout and fully
        // best-effort — if it can't produce one, fall through to normal max_turns handling.
        if (wrapUpRequested && !abortedForMaxTurns) {
          try {
            const wrapHandle = session.prompt(WRAP_UP_INSTRUCTION, {
              ...promptOptions,
              model,
              signal: AbortSignal.timeout(WRAP_UP_TIMEOUT_MS),
            });
            currentHandle = wrapHandle;
            const wrapped = (await wrapHandle) as unknown as TurnResult;
            return { ...wrapped, partial: true };
          } catch {
            // Wrap-up failed (session busy after abort, timed out, or hit the hard ceiling):
            // treat as a normal turn-budget exhaustion so the CLI posts the max_turns comment.
            abortedForMaxTurns = true;
            throw new Error(`crabd: max_turns (${maxTurns}) exceeded`);
          }
        }
        throw err;
      }
    };

    /**
     * The opt-in second pass: send each candidate finding to an independent, blinded refuter and
     * keep only what survives.
     *
     * Every refuter runs in its own child session (`agent: 'refuter'`), so it sees the claim and the
     * code but *not* the reviewer's reasoning — which is the whole point, since a verifier that can
     * read the argument tends to agree with it. Entirely best-effort and additive: any failure keeps
     * the original findings, because losing a real review to a flaky extra call is the worse outcome.
     *
     * Returns `undefined` when the stage didn't run, so the caller can tell "not run" from "ran and
     * confirmed everything".
     */
    const verifyFindings = async (
      data: JsonValue,
      model: string,
      partial: boolean,
    ): Promise<{ data: JsonValue; confirmed: number; refuted: number } | undefined> => {
      const cfg = verifyConfig();
      if (!cfg.enabled || input.mode !== 'review' || !lastSession) return undefined;
      // A partial answer already ran out of budget; spending more on verification would just make
      // the timeout worse.
      if (partial) return undefined;

      const output = data as ReviewOutput | null;
      const findings = output?.findings;
      if (!Array.isArray(findings) || findings.length === 0) return undefined;

      const diff = readDiff();
      const repoSlug =
        process.env.CRABD_REPO_OWNER && process.env.CRABD_REPO_NAME
          ? `${process.env.CRABD_REPO_OWNER}/${process.env.CRABD_REPO_NAME}`
          : 'this repository';
      const verifyModel = cfg.model ?? model;

      const verdicts = await mapWithConcurrency(
        findings,
        cfg.maxConcurrency,
        async (finding: ReviewFinding): Promise<RefuterVerdict | undefined> => {
          try {
            const response = await lastSession!.task(buildRefuterPrompt(finding, { repoSlug, ...(diff ? { diff } : {}) }), {
              agent: 'refuter',
              result: RefuterVerdictSchema,
              model: verifyModel,
            });
            return (response as { data?: RefuterVerdict }).data;
          } catch {
            // This finding simply goes unverified; see survivesRefutation.
            return undefined;
          }
        },
      );

      const kept: ReviewFinding[] = [];
      let refuted = 0;
      findings.forEach((finding, i) => {
        const verdict = verdicts[i];
        if (survivesRefutation(verdict, cfg.minConfidence)) {
          // A refuter that agreed but found a better line is worth listening to.
          const line = verdict?.correctedLine;
          kept.push(typeof line === 'number' && line > 0 ? { ...finding, line } : finding);
          return;
        }
        refuted++;
      });

      if (target) {
        const summary = `Verified ${kept.length} of ${findings.length} findings (${refuted} refuted).`;
        await target.adapter
          .updateTrackingComment(target.tracking, renderProgress(brand, input.mode, summary))
          .catch(() => {});
      }

      return { data: { ...output, findings: kept } as unknown as JsonValue, confirmed: kept.length, refuted };
    };

    let outcome;
    try {
      outcome = await runWithFallback<TurnResult>({
        chain,
        triggerScope: rl.triggerScope,
        backoff: rl.backoff,
        maxWaitMs,
        runOnce,
        // A deliberate max_turns abort must not be mistaken for a rate limit.
        isFatal: () => abortedForMaxTurns,
        onSwitch: ({ fromModel, nextModel, attempt, waitMs }) => {
          postRateLimited(
            {
              mode: input.mode,
              provider: providerOf(fromModel),
              nextModel,
              attempt,
              waitSeconds: waitMs / 1000,
              switching: true,
            },
            true,
          );
        },
      });
    } catch (err) {
      // A fatal error escaped the fallback loop — a deliberate max_turns abort, a durability
      // timeout, or an unexpected model/tool failure. Return it as a structured failure so the
      // CLI posts a helpful comment instead of the subprocess dying with a raw stack trace.
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: describeFatal(message, abortedForMaxTurns, maxTurns) } as JsonValue;
    } finally {
      unsubscribe();
    }

    if (outcome.ok) {
      const meta: Record<string, JsonValue> = { modelUsed: outcome.result.model ?? outcome.model };
      if (outcome.fellBack) meta.fellBackFrom = primaryModel;
      if (outcome.result.partial) meta.partial = true;

      let data = outcome.result.data;
      const verified = await verifyFindings(data, outcome.result.model ?? outcome.model, outcome.result.partial === true);
      if (verified) {
        data = verified.data;
        meta.verified = verified.confirmed;
        meta.refuted = verified.refuted;
      }

      return { ok: true, data, meta } as JsonValue;
    }

    const error: Record<string, JsonValue> = {
      kind: 'rate_limited',
      message: outcome.lastError,
      attempts: outcome.attempts,
    };
    if (outcome.lastModel) error.lastModel = outcome.lastModel;
    return { ok: false, error } as JsonValue;
  },
});

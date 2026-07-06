import {
  connectMcpServer,
  defineAgent,
  defineTool,
  defineWorkflow,
  observe,
  type JsonValue,
  type ToolDefinition,
} from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import {
  DEFAULT_BRANDING,
  ForgejoForge,
  GitHubForge,
  StaticTokenAuth,
  buildAttemptChain,
  getMode,
  registerBuiltinModes,
  registerMode,
  renderProgress,
  renderRateLimited,
  runWithFallback,
  type Branding,
  type ForgeAdapter,
  type ForgeRepo,
  type ModeDefinition,
  type TrackingComment,
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
const agent = defineAgent(() => ({
  model: process.env.CRABD_MODEL ?? 'anthropic/claude-sonnet-4-6',
  instructions: process.env.CRABD_INSTRUCTIONS ?? '',
  ...(process.env.CRABD_THINKING_LEVEL ? { thinkingLevel: process.env.CRABD_THINKING_LEVEL as never } : {}),
  ...(timeoutMs && Number.isFinite(timeoutMs) ? { durability: { timeoutMs } } : {}),
  sandbox: local({ cwd: process.env.CRABD_CWD ?? process.cwd(), env: sandboxEnv() }),
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

export default defineWorkflow({
  agent,
  input: v.object({
    mode: v.string(),
    message: v.string(),
    images: v.optional(v.array(v.string())),
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
    const unsubscribe = observe((event) => {
      if (event.type === 'tool_start') {
        toolStarts += 1;
        if (maxTurns && Number.isFinite(maxTurns) && toolStarts > maxTurns && currentHandle) {
          abortedForMaxTurns = true;
          currentHandle.abort(new Error(`crabd: max_turns (${maxTurns}) exceeded`));
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
    const runOnce = async (model: string, index: number): Promise<{ data: JsonValue; model?: string }> => {
      currentModel = model;
      toolStarts = 0;
      abortedForMaxTurns = false;
      const session = index === 0 ? await harness.session() : await harness.session(`crabd-fallback-${index}`);
      const handle = session.prompt(input.message, { ...promptOptions, model });
      currentHandle = handle;
      return (await handle) as unknown as { data: JsonValue; model?: string };
    };

    let outcome;
    try {
      outcome = await runWithFallback<{ data: JsonValue; model?: string }>({
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
    } finally {
      unsubscribe();
    }

    if (outcome.ok) {
      const meta: Record<string, JsonValue> = { modelUsed: outcome.result.model ?? outcome.model };
      if (outcome.fellBack) meta.fellBackFrom = primaryModel;
      return { ok: true, data: outcome.result.data, meta } as JsonValue;
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

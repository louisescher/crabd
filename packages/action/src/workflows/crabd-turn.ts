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
  ForgejoForge,
  GitHubForge,
  StaticTokenAuth,
  getMode,
  registerBuiltinModes,
  registerMode,
  renderProgress,
  type ForgeAdapter,
  type ForgeRepo,
  type ModeDefinition,
  type TrackingComment,
} from '@crabd/core';
import { loadCrabdExtension } from '@crabd/config';
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

/** A tool the agent calls to post progress to the tracking comment mid-run. */
function progressTool(mode: string): ToolDefinition | undefined {
  const target = progressTarget();
  if (!target) return undefined;
  return defineTool({
    name: 'report_progress',
    description: 'Post a short progress update to the tracking comment so humans can follow along. Use for meaningful milestones, not every step.',
    input: v.object({ message: v.string() }),
    async run({ input }) {
      try {
        await target.adapter.updateTrackingComment(target.tracking, renderProgress(mode, input.message));
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

    const [connected, images] = await Promise.all([mcpTools(), fetchImages(input.images ?? [])]);
    const progress = progressTool(input.mode);
    const tools = [...(progress ? [progress] : []), ...connected, ...configuredWebSearchTools()];

    const session = await harness.session();
    const handle = session.prompt(input.message, {
      result: mode.outputSchema,
      ...(tools.length > 0 ? { tools } : {}),
      ...(images.length > 0 ? { images } : {}),
    });

    // Hard max_turns ceiling: count tool-call starts and abort once exceeded.
    const maxTurns = process.env.CRABD_MAX_TURNS ? Number(process.env.CRABD_MAX_TURNS) : undefined;
    let unsubscribe: () => void = () => {};
    if (maxTurns && Number.isFinite(maxTurns)) {
      let toolStarts = 0;
      unsubscribe = observe((event) => {
        if (event.type === 'tool_start') {
          toolStarts += 1;
          if (toolStarts > maxTurns) {
            handle.abort(new Error(`crabd: max_turns (${maxTurns}) exceeded`));
          }
        }
      });
    }

    try {
      const response = (await handle) as unknown as { data: JsonValue };
      return response.data;
    } finally {
      unsubscribe();
    }
  },
});

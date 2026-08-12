import { defineTool, type McpConnectionDefinition, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import { renderProgress, type Branding, type ForgeAdapter, type TrackingComment } from '@crabd/core';
import type { ResolvedConfig, ResolvedMcpServer, ResolvedReviewVerify, ThinkingLevel } from '@crabd/config';
import { webSearchTools } from './tools/websearch.ts';

/** Where the agent posts progress, when the run has a tracking comment to post to. */
export interface ProgressTarget {
  adapter: ForgeAdapter;
  tracking: TrackingComment;
}

/**
 * Everything about this run that the agents and the turn runner need.
 *
 * This used to be ~20 `CRABD_*` env vars, because the turn ran in a `flue run` subprocess and JSON in
 * the environment was the only way across. The turn is a function call now, so the values are passed
 * as values. Per-instance facts (which mode, which model of the fallback chain) still travel as an
 * instance's creation data, since those differ between instances of the same run.
 *
 * Module-scoped rather than threaded through every signature: an agent function receives only its id
 * and its hooks, so a render has no parameter to read this from. One process serves one run, which is
 * what makes that safe.
 */
export interface RunContext {
  /** The checkout the sandbox and the mode validators work against. */
  cwd: string;
  /** A stable prefix for conversation ids, so one run's instances never collide with another's. */
  runId: string;
  /** Reasoning effort for the turn. v2's `ThinkingLevel` is exactly crab'd's config values. */
  thinkingLevel?: ThinkingLevel;
  /** Env vars forwarded into the model's shell. Empty by default: nothing leaks to `bash`. */
  sandboxEnv: Record<string, string | undefined>;
  branding: Branding;
  webSearch: { enabled: boolean; maxResults: number };
  verify: ResolvedReviewVerify;
  mcp: ResolvedMcpServer[];
  maxTurns?: number;
  timeoutMs?: number;
  /** The forge token, used to fetch images from authenticated forge hosts. */
  forgeToken?: string;
  /** `owner/repo`, for the refuter's prompt. */
  repoSlug?: string;
  /** Where the CLI wrote the diff, when the mode has one. */
  diffPath?: string;
  progress?: ProgressTarget;
}

let current: RunContext | undefined;

export function setRunContext(context: RunContext): void {
  current = context;
}

/**
 * The active run's context. Throws rather than defaulting: every caller runs inside a turn, and a
 * silently empty context is how a missing `context_window` became a one-token cap.
 */
export function runContext(): RunContext {
  if (!current) throw new Error('crabd: no run context — setRunContext() must run before the runtime starts');
  return current;
}

/** Build the run context from the resolved config plus what only the CLI knows about this run. */
export function buildRunContext(input: {
  config: ResolvedConfig;
  cwd: string;
  runId: string;
  thinkingLevel?: ThinkingLevel;
  sandboxEnv?: Record<string, string | undefined>;
  forgeToken?: string;
  repoSlug?: string;
  diffPath?: string;
  progress?: ProgressTarget;
}): RunContext {
  const { config } = input;
  return {
    cwd: input.cwd,
    runId: input.runId,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    sandboxEnv: input.sandboxEnv ?? {},
    branding: config.appearance,
    webSearch: config.webSearch,
    verify: config.review.verify,
    mcp: config.mcp,
    ...(config.limits.maxTurns ? { maxTurns: config.limits.maxTurns } : {}),
    ...(config.limits.timeoutMinutes
      ? { timeoutMs: Math.round(config.limits.timeoutMinutes * 60_000) }
      : {}),
    ...(input.forgeToken ? { forgeToken: input.forgeToken } : {}),
    ...(input.repoSlug ? { repoSlug: input.repoSlug } : {}),
    ...(input.diffPath ? { diffPath: input.diffPath } : {}),
    ...(input.progress ? { progress: input.progress } : {}),
  };
}

/** A tool the agent calls to post progress to the tracking comment mid-run. */
export function progressTool(mode: string): ToolDefinition | undefined {
  const { progress, branding } = runContext();
  if (!progress) return undefined;
  return defineTool({
    name: 'report_progress',
    description:
      'Post a short progress update to the tracking comment so humans can follow along. Use for meaningful milestones, not every step.',
    input: v.object({ message: v.string() }),
    async run({ data }) {
      try {
        await progress.adapter.updateTrackingComment(progress.tracking, renderProgress(branding, mode, data.message));
      } catch {
        // Progress updates are best-effort.
      }
      return { output: { ok: true } };
    },
  });
}

/**
 * Configured MCP servers as declarations rather than eager connections: v2 connects them when a
 * submission initializes. `optional` keeps a server we cannot reach from failing the whole run, which
 * is what the old connect-and-skip loop did by hand.
 */
export function mcpConnections(): McpConnectionDefinition[] {
  return runContext().mcp.map((server) => ({
    name: server.name,
    url: server.url,
    ...(server.transport ? { transport: server.transport } : {}),
    ...(server.headers ? { headers: server.headers } : {}),
    optional: true,
  }));
}

/** Web-search / fetch tools, unless disabled via config. */
export function configuredWebSearchTools(): ToolDefinition[] {
  const { webSearch } = runContext();
  if (!webSearch.enabled) return [];
  return webSearchTools({ maxResults: webSearch.maxResults });
}

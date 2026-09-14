import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineTool, type McpConnectionDefinition, type ToolDefinition } from '@flue/runtime';
import * as v from 'valibot';
import {
  collectChangesSinceBaseline,
  renderProgress,
  writeMemory,
  type Baseline,
  type CommentContext,
  type ForgeAdapter,
  type RunMemory,
  type TrackingComment,
} from '@crabd/core';
import type { ResolvedConfig, ResolvedMcpServer, ResolvedReviewVerify, ThinkingLevel } from '@crabd/config';
import { log } from './logger.ts';
import { webSearchTools } from './tools/websearch.ts';

/**
 * What `update_branch` needs to merge a pull request's base into its head and move this run onto
 * the result. The getters read the CLI's own plan objects, which `finalizeRun` reads too.
 */
export interface BranchUpdateTarget {
  adapter: ForgeAdapter;
  prNumber: number;
  cwd: string;
  headSha(): string;
  baseline(): Baseline;
  /** Checks the workspace out onto `headSha` and re-points the pull request. False if it could not move. */
  apply(headSha: string): boolean;
}

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
  /**
   * Branding for the comments the turn posts, carrying the run's advisories. The plan's version
   * rather than `config.appearance`: a warning that vanished during progress updates and came back
   * at the end would read as a glitch.
   */
  branding: CommentContext;
  /** Verb key for crab'd's own comments. Falls back to the mode name. */
  verbKey?: string;
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
  /** Present only on a pull request crab'd can write to; absent means `update_branch` is not mounted. */
  branchUpdate?: BranchUpdateTarget;
  /**
   * Whether this run may record a memory, and where they live. Resolved before the turn starts so
   * the tool is simply absent when crab'd could not commit the result — see `RunMemory`.
   */
  memory?: RunMemory;
  /**
   * Date stamped on a recorded memory, as `YYYY-MM-DD`. Passed in rather than read from the clock
   * inside the tool so a run's output is a function of its inputs.
   */
  today?: string;
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
  branchUpdate?: BranchUpdateTarget;
  memory?: RunMemory;
  today?: string;
  /** The plan's branding, carrying any advisories. Falls back to plain `config.appearance`. */
  branding?: CommentContext;
  verbKey?: string;
}): RunContext {
  const { config } = input;
  return {
    cwd: input.cwd,
    runId: input.runId,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
    sandboxEnv: input.sandboxEnv ?? {},
    branding: input.branding ?? config.appearance,
    ...(input.verbKey ? { verbKey: input.verbKey } : {}),
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
    ...(input.branchUpdate ? { branchUpdate: input.branchUpdate } : {}),
    ...(input.memory ? { memory: input.memory } : {}),
    ...(input.today ? { today: input.today } : {}),
  };
}

/**
 * Memories the `remember` tool wrote during this run, in call order.
 *
 * Module-scoped for the same reason the run context is: an agent render receives only its hooks, so
 * a tool has nowhere to hand a result back to. One process serves one run, and the CLI reads this
 * once after the turn settles to decide what to commit.
 */
const recorded: string[] = [];

/**
 * Where recorded memories are staged: a scratch directory, never the checkout.
 *
 * Writing them into the working tree would put them in front of `collectChangesSinceBaseline`, so a mode that
 * commits its working-tree changes (`mention`, `implement`, or any custom mode) would sweep the
 * memory into its own commit — and `commitMemories` would then commit it again, on a different
 * branch. A memory is a side effect of the conversation, not part of the change under review.
 */
function stagingRoot(): string {
  return join(tmpdir(), 'crabd-memory', runContext().runId);
}

/** The staging root and the repo-relative paths of every memory recorded this run. */
export function recordedMemories(): { root: string; paths: string[] } {
  return { root: stagingRoot(), paths: [...recorded] };
}

/**
 * The tool that records a durable correction, mounted only when this run could actually commit one.
 *
 * The mechanical gate (is this a reply to crab'd, can we write, is memory on) is already settled by
 * the time this is called — `memory.writable` carries that answer. What the description has to
 * carry is the part no gate can check: that a memory is a *settled ruling about this repository*,
 * not a note about the pull request in front of it. Hence the explicit counter-examples; a model
 * given only "record what you learned" will record the change it just reviewed.
 */
export function rememberTool(): ToolDefinition | undefined {
  const { memory, today } = runContext();
  if (!memory?.writable) return undefined;

  return defineTool({
    name: 'remember',
    description: [
      'Record a durable fact about THIS REPOSITORY that you got wrong, so future runs do not repeat the mistake.',
      'Call this only when a human has corrected you in the comment you are replying to, and the correction generalizes.',
      '',
      'Before you call this, re-read the "## What you have learned about this repository" section already in your',
      'system prompt, if present. Its headings are the exact `name` of each existing memory. If this correction',
      'refines, narrows, or overturns one of them, call `remember` again with that SAME name, so your entry replaces',
      'it wholesale, rather than sitting alongside a now-stale one that still has to be reconciled by whoever reads',
      'the memory directory. Only pick a new name when this is a genuinely different convention.',
      '',
      'Record: a convention this repo follows deliberately, a pattern that is intentional and should not be flagged,',
      'a project-specific fact that made your finding wrong.',
      '',
      'State the memory in the specific terms of what was actually corrected: the exact rule, path segment, or',
      'pattern from the discussion, not a paraphrase of a fact you already knew. If what you are about to write',
      'could have been written without reading this conversation, it is too generic: find the narrower, more',
      'specific rule the human was actually pointing at instead.',
      '',
      'Do NOT record: anything about this one pull request or its diff, a restatement of the code, a general programming',
      'fact true of every codebase, or your own summary of the conversation. If you would not want it read aloud before',
      'every future review of this repository, do not record it.',
      '',
      'Recording is cheap but not free: each memory is committed as a file a human has to review. One precise memory',
      'beats three vague ones. If the correction does not generalize, do not call this at all.',
    ].join('\n'),
    input: v.object({
      name: v.pipe(
        v.string(),
        v.description(
          'Short kebab-case identifier, e.g. "no-barrel-files". Match an existing heading from the memory section ' +
            'above to replace it, otherwise pick a new one.',
        ),
      ),
      memory: v.pipe(
        v.string(),
        v.description('The instruction itself, in one or two sentences, addressed to your future self.'),
      ),
      source: v.pipe(
        v.optional(v.string()),
        v.description('Permalink to the comment that taught you this, when you have one.'),
      ),
    }),
    run: ({ data }) => {
      try {
        const path = writeMemory(stagingRoot(), {
          name: data.name,
          body: data.memory,
          ...(data.source ? { source: data.source } : {}),
          recorded: today ?? new Date().toISOString().slice(0, 10),
          dir: memory.dir,
        });
        if (!recorded.includes(path)) recorded.push(path);
        log(`remember: recorded "${data.name}" (${data.memory.length} chars) at ${path}`);
        return { output: { recorded: path } };
      } catch (error) {
        // Report the failure to the model rather than throwing: it can decide whether to retry with
        // a different name, and a failed memory must never take the answer down with it.
        const message = error instanceof Error ? error.message : String(error);
        log(`remember: failed to record "${data.name}": ${message}`);
        return { output: { error: message } };
      }
    },
  });
}

/**
 * The tool that answers "update this branch" and "fix the merge conflicts". The merge happens on
 * the forge under crab'd's identity, and the run's checkout moves onto the result so a later
 * commit builds on the merged tree instead of reverting it.
 */
export function updateBranchTool(): ToolDefinition | undefined {
  const { branchUpdate } = runContext();
  if (!branchUpdate) return undefined;

  return defineTool({
    name: 'update_branch',
    description: [
      "Merge this pull request's base branch into its head branch, on the forge, and move your",
      'checkout onto the result.',
      '',
      'This is the only way to bring the branch up to date or to deal with it being behind its base.',
      'You cannot merge or rebase yourself.',
      '',
      'Call it BEFORE you edit anything: it refuses once you have changed a file, because moving the',
      'checkout would discard that change. If it reports a conflict, the merge needs a human. Say so in your',
      'answer and stop rather than trying to work around it.',
    ].join('\n'),
    input: v.object({
      reason: v.pipe(
        v.string(),
        v.description('One line on why the branch needs updating, for the run log.'),
      ),
    }),
    async run({ data }) {
      const pending = collectChangesSinceBaseline(branchUpdate.cwd, branchUpdate.baseline());
      if (pending.length > 0) {
        return {
          output: {
            status: 'refused',
            message: `You have already changed ${pending.length} file(s). Updating the branch would move the checkout out from under them. Finish and submit this run, then ask for the update in a new one.`,
          },
        };
      }

      log(`update_branch: ${data.reason}`);
      let update;
      try {
        update = await branchUpdate.adapter.updateBranch(branchUpdate.prNumber, {
          expectedHeadSha: branchUpdate.headSha(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`update_branch: failed: ${message}`);
        return { output: { status: 'error', message } };
      }

      if (update.status !== 'updated') {
        log(`update_branch: ${update.status}`);
        return { output: update };
      }

      if (!branchUpdate.apply(update.headSha)) {
        return {
          output: {
            status: 'desynced',
            head_sha: update.headSha,
            message:
              'The branch was updated on the forge, but your checkout could not be moved onto the new head. Anything you commit from here would revert the merge, so nothing more will be committed on this run. Report that the branch is now up to date and stop.',
          },
        };
      }

      log(`update_branch: moved onto ${update.headSha}`);
      return {
        output: {
          status: 'updated',
          head_sha: update.headSha,
          message:
            'Your checkout is now on the merged head. The diff and review threads in your context were captured before the merge, so re-read any file before you change it.',
        },
      };
    },
  });
}

/** A tool the agent calls to post progress to the tracking comment mid-run. */
export function progressTool(mode: string): ToolDefinition | undefined {
  const { progress, branding, verbKey } = runContext();
  if (!progress) return undefined;
  return defineTool({
    name: 'report_progress',
    description:
      'Post a short progress update to the tracking comment so humans can follow along. Use for meaningful milestones, not every step.',
    input: v.object({ message: v.string() }),
    async run({ data }) {
      try {
        await progress.adapter.updateTrackingComment(
          progress.tracking,
          renderProgress(branding, verbKey ?? mode, data.message),
        );
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

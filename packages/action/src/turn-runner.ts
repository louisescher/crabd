import { getHeapStatistics } from 'node:v8';
import { init, observe, type FlueEvent, type JsonValue } from '@flue/runtime';
import {
  buildAttemptChain,
  expandCommentableLines,
  getMode,
  renderProgress,
  renderRateLimited,
  runWithFallback,
  type ValidateContext,
} from '@crabd/core';
import { providerOf, type ResolvedRateLimit } from '@crabd/config';
import { CrabdTurn, type TurnCreation } from './agents/crabd-turn.ts';
import { debug, group, log, warn } from './logger.ts';
import { summarizeToolArgs } from './tool-log.ts';
import { noteActivity } from './watchdog.ts';
import { runContext } from './run-context.ts';
import { verifyFindings } from './verify.ts';

/** How long a self-correction turn may run before the original answer is kept instead. */
const REPAIR_TIMEOUT_MS = 90_000;

/**
 * Two repair rounds. A model that cannot anchor its findings correctly twice in a row is not going
 * to on the third try, and every round costs a full turn.
 */
const MAX_REPAIR_ATTEMPTS = 2;

const WRAP_UP_INSTRUCTION = [
  'You are out of exploration budget. Stop investigating and submit your answer now,',
  'based only on what you already know. Call submit with your best current answer.',
].join(' ');

/** How long the graceful wrap-up (final-answer) prompt may run before it's abandoned. */
const WRAP_UP_TIMEOUT_MS = 90_000;

/**
 * How many times to re-ask a model that answered in prose instead of calling `submit`. flue 1's
 * `result` option owned this loop with a ceiling of 32; two is plenty here, because the directive is
 * already in the instructions and each round costs a full turn.
 */
const MAX_SUBMIT_NUDGES = 2;

const SUBMIT_NUDGE = [
  'Your reply was not recorded: answers only reach the user through the `submit` tool.',
  'Call `submit` now with the answer you just gave.',
].join(' ');

/**
 * Re-runs of a turn whose *harness* lost the conversation rather than whose model failed. One is
 * enough: a fresh instance starts from an empty conversation, so either the replacement turn runs or
 * the stale tail was never the problem.
 */
const MAX_HARNESS_RETRIES = 1;

/**
 * Tools whose call is the point of the run. They are exempt from the turn budget: a run reaching
 * one of these has finished, and cutting it off there loses the answer and the work behind it.
 */
const TERMINAL_TOOLS = new Set(['submit']);

/**
 * How much of the wall-clock budget is held back for a graceful wrap-up, matching the reserve the
 * turn ceiling already keeps. Without it a run that runs out of time is killed with no answer at
 * all, while a run that runs out of tool calls gets asked for its best one.
 */
const DEADLINE_WRAP_UP_MS = 90_000;
/** Fraction of the wall-clock budget that may go to the wrap-up, for short deadlines. */
const DEADLINE_WRAP_UP_RATIO = 0.15;

/** How often the heap watchdog samples usage. */
const HEAP_CHECK_INTERVAL_MS = 5_000;
/** Heap usage ratio at which the watchdog logs a one-time warning. */
const HEAP_WARN_RATIO = 0.75;
/** Heap usage ratio at which the watchdog aborts the current attempt rather than let V8 OOM-crash. */
const HEAP_ABORT_RATIO = 0.92;

function heapUsageRatio(): { ratio: number; usedMb: number; limitMb: number } {
  const { used_heap_size, heap_size_limit } = getHeapStatistics();
  return {
    ratio: used_heap_size / heap_size_limit,
    usedMb: Math.round(used_heap_size / 1_048_576),
    limitMb: Math.round(heap_size_limit / 1_048_576),
  };
}

export interface TurnInput {
  mode: string;
  message: string;
  /** The mode's system instructions, resolved by the caller. */
  instructions: string;
  images?: string[];
  validation?: {
    changedPaths: string[];
    anchorable: { path: string; ranges: string[] }[];
    subjectKind?: 'issue' | 'pull_request';
    threadIds?: string[];
    verifyCommands?: string[];
  };
}

export interface TurnOutcome {
  ok: boolean;
  data?: JsonValue;
  meta?: Record<string, JsonValue>;
  error?: Record<string, JsonValue>;
}

interface AttemptResult {
  data: JsonValue;
  model?: string;
  partial?: boolean;
}

/**
 * The model's own words for one turn: the reasoning it was willing to expose, and whatever it said
 * outside a tool call. Gemini and Claude both put these in the assistant message the `turn` event
 * carries, which is the only place a run sees them: flue's `thinking_*` stream events reach an
 * attached-agent stream, not `observe`.
 */
export function readAssistantContent(output: unknown): { thinking: string; text: string } {
  const content = (output as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return { thinking: '', text: '' };
  const thinking: string[] = [];
  const text: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const b = block as { type?: string; thinking?: unknown; text?: unknown; redacted?: boolean };
    if (b.type === 'thinking' && typeof b.thinking === 'string' && !b.redacted) thinking.push(b.thinking);
    if (b.type === 'text' && typeof b.text === 'string') text.push(b.text);
  }
  return { thinking: thinking.join('\n\n').trim(), text: text.join('\n').trim() };
}

export function describeFatal(
  message: string,
  maxTurnsHit: boolean,
  resourceExhausted: boolean,
  timedOut: boolean,
  maxTurns?: number,
  timeoutMs?: number,
): Record<string, JsonValue> {
  const minutes = timeoutMs ? timeoutMs / 60_000 : undefined;
  // Checked first: aborting past the deadline surfaces as a generic "aborted" message.
  if (timedOut) return { kind: 'timeout', message, ...(minutes ? { timeoutMinutes: minutes } : {}) };
  if (resourceExhausted) return { kind: 'resource_exhausted', message };
  if (maxTurnsHit) return { kind: 'max_turns', message, ...(maxTurns ? { maxTurns } : {}) };
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) {
    return { kind: 'timeout', message, ...(minutes ? { timeoutMinutes: minutes } : {}) };
  }
  return { kind: 'error', message };
}

/**
 * Flatten a serialized event error into text the rate-limit classifier can read.
 *
 * `AgentRunError` — what `handle.read()` rejects with — carries only `{ outcome, submissionId }`: no
 * cause, no provider detail, and a message that says nothing but "Agent run failed". The provider's
 * status is only on the `turn` event's serialized `error`. Classifying the rejection alone therefore
 * calls every rate limit fatal and the fallback chain never engages, which is why the reason is
 * captured from the event stream and joined onto the message here.
 */
export function describeTurnError(error: unknown): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  const e = error as { message?: unknown; details?: unknown; meta?: Record<string, unknown> };
  const parts: string[] = [];
  if (typeof e.message === 'string') parts.push(e.message);
  if (typeof e.details === 'string' && e.details) parts.push(e.details);
  for (const value of Object.values(e.meta ?? {})) {
    if (typeof value === 'string') parts.push(value);
  }
  return parts.length > 0 ? parts.join(' | ') : JSON.stringify(error);
}

/**
 * The provider failure behind a `[flue:model-retry]` log event.
 *
 * flue reports the error it is about to retry on the log event's `attributes.error` and its CLI
 * prints only the message, so without reading the attributes a run's entire record of why the model
 * failed is the words "Retrying transient model error". That matters beyond the log: the retry can
 * then fail for a reason of its own (see {@link isHarnessRecoveryFailure}) and the actual cause is
 * gone by the time anything classifies the attempt.
 */
export function retryErrorDetail(attributes: unknown): string {
  if (!attributes || typeof attributes !== 'object') return '';
  const { error } = attributes as { error?: unknown };
  return error ? describeTurnError(error) : '';
}

/**
 * A timeout signal that also fires when the run's own deadline does, so a bounded sub-call can
 * never outlive the run it belongs to.
 */
function boundedSignal(timeoutMs: number, deadline: AbortSignal | undefined): AbortSignal {
  const own = AbortSignal.timeout(timeoutMs);
  return deadline ? AbortSignal.any([own, deadline]) : own;
}

/** What flue reports alongside a retry, when it reports it. Every field is optional by design. */
export interface ModelRetry {
  attempt?: number;
  maxRetries?: number;
  delayMs?: number;
  detail: string;
}

/**
 * The whole of a `[flue:model-retry]` log event, not just its error, so a retry comment can name
 * the attempt number and backoff instead of just "retrying".
 */
export function parseModelRetry(attributes: unknown): ModelRetry {
  const detail = retryErrorDetail(attributes);
  if (!attributes || typeof attributes !== 'object') return { detail };
  const a = attributes as { attempt?: unknown; maxRetries?: unknown; delayMs?: unknown };
  const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    detail,
    ...(num(a.attempt) !== undefined ? { attempt: num(a.attempt) } : {}),
    ...(num(a.maxRetries) !== undefined ? { maxRetries: num(a.maxRetries) } : {}),
    ...(num(a.delayMs) !== undefined ? { delayMs: num(a.delayMs) } : {}),
  };
}

/**
 * Whether a failure is flue's recovery path giving up on the conversation rather than the model
 * refusing the work.
 *
 * flue retries a transient model error by resuming the conversation it already has. When that
 * conversation's tail projects to an assistant message, pi-agent-core's `continue()` rejects it and
 * the turn dies holding an answer it was seconds away from submitting. The model is not at fault and
 * the same instance can never recover, because its persisted tail is the thing that breaks it, so the
 * only useful response is to re-run the turn on a fresh one.
 *
 * Observed on flue 2.0.3, where `runModelTurnWithRecovery` guards exactly this case with a `restart`
 * callback that the durable dispatch path crab'd uses never passes.
 */
export function isHarnessRecoveryFailure(message: string): boolean {
  return /cannot continue from message role|cannot continue: no messages in context|no messages to continue from/i.test(
    message,
  );
}

/** Fetch image URLs into inline base64 attachments for a vision-capable model. */
async function fetchImages(
  urls: string[],
  forgeToken: string | undefined,
): Promise<{ type: 'image'; data: string; mimeType: string }[]> {
  const images: { type: 'image'; data: string; mimeType: string }[] = [];
  for (const url of urls) {
    try {
      const sameHostAsForge = forgeToken && /github|githubusercontent|forgejo/i.test(new URL(url).host);
      const res = await fetch(url, sameHostAsForge ? { headers: { Authorization: `Bearer ${forgeToken}` } } : {});
      if (!res.ok) continue;
      const mimeType = (res.headers.get('content-type') ?? 'image/png').split(';')[0] ?? 'image/png';
      if (!mimeType.startsWith('image/')) continue;
      const data = Buffer.from(await res.arrayBuffer()).toString('base64');
      // A delivered attachment is capped at 14 MiB of base64 characters; an oversized image would
      // otherwise fail the whole dispatch rather than just going unseen.
      if (data.length > 14 * 1024 * 1024) continue;
      images.push({ type: 'image', data, mimeType });
    } catch {
      // Skip unreadable images.
    }
  }
  return images;
}

/**
 * Run one crab'd turn, including the rate-limit fallback chain, the turn budget, the repair pass, and
 * the opt-in verify stage.
 *
 * This is the workflow body from flue 1, moved into the caller. In v2 an agent is one addressable
 * conversation, so "how many turns do we spend, on which model, and do we start clean" are the
 * caller's decisions — expressed as instances rather than sessions.
 */
export async function runTurn(input: TurnInput, rl: ResolvedRateLimit, primaryModel: string): Promise<TurnOutcome> {
  const ctx = runContext();
  const mode = getMode(input.mode);
  if (!mode) throw new Error(`crabd: no mode registered for "${input.mode}"`);

  const target = ctx.progress;
  const brand = ctx.branding;
  const chain = buildAttemptChain(primaryModel, rl.fallbackModels, rl.maxRetries);
  // Clamped to the run deadline: a backoff that outlives the budget it is spending is not a budget.
  const maxWaitMs = Math.min(Math.max(0, rl.maxWaitSeconds) * 1000, ctx.timeoutMs ?? Number.POSITIVE_INFINITY);

  const hasMaxTurns = !!(ctx.maxTurns && ctx.maxTurns > 0);
  const maxTurns = hasMaxTurns ? ctx.maxTurns! : 0;
  // Reserve a few turns at the end of the budget for a graceful wrap-up: crab'd stops exploring at
  // `softLimit` and spends the reserve asking the model to submit, so reaching the ceiling yields a
  // useful partial answer instead of a bare abort.
  const wrapUpReserve = hasMaxTurns ? Math.min(4, Math.max(1, Math.floor(maxTurns * 0.15))) : 0;
  const softLimit = hasMaxTurns ? Math.max(1, maxTurns - wrapUpReserve) : 0;

  let lastRlUpdate = 0;
  const postRateLimited = (render: Parameters<typeof renderRateLimited>[1], force = false): void => {
    if (!target) return;
    const now = Date.now();
    if (!force && now - lastRlUpdate < 1500) return;
    lastRlUpdate = now;
    target.adapter.updateTrackingComment(target.tracking, renderRateLimited(brand, render)).catch(() => {});
  };

  // The turn budget, rebuilt: v2 enforces no step or turn cap of its own (see its Limits table), so
  // counting tool starts and aborting is still crab'd's job. What changed is the abort surface —
  // `handle.abort()` is a durable instance abort rather than cancelling one prompt call.
  let toolStarts = 0;
  // Counted across the whole run: flue's own same-model retries happen inside one `handle.read`,
  // before crab'd's fallback chain sees anything.
  let transientRetries = 0;
  let currentModel = primaryModel;
  let currentAbort: (() => Promise<void>) | undefined;

  // One deadline for the whole run, created before the chain: a per-attempt timer bounds nothing
  // once the fallback chain walks to the next model.
  const deadline = ctx.timeoutMs ? AbortSignal.timeout(ctx.timeoutMs) : undefined;
  let abortedForTimeout = false;
  deadline?.addEventListener('abort', () => {
    abortedForTimeout = true;
    warn(`[${ctx.runId}] run deadline of ${(ctx.timeoutMs ?? 0) / 60_000} minutes reached, aborting`);
    // Cancelling the read alone leaves the submission running, so abort the instance.
    void currentAbort?.();
  });
  let abortedForMaxTurns = false;
  let wrapUpRequested = false;

  // The wall clock gets the same courtesy as the tool ceiling: stop exploring a little early and
  // spend what is left asking for the best current answer.
  const wrapUpReserveMs = ctx.timeoutMs
    ? Math.min(DEADLINE_WRAP_UP_MS, Math.floor(ctx.timeoutMs * DEADLINE_WRAP_UP_RATIO))
    : 0;
  const softDeadline =
    ctx.timeoutMs && wrapUpReserveMs > 0 ? setTimeout(() => {
      if (wrapUpRequested || abortedForTimeout) return;
      wrapUpRequested = true;
      log(`[${ctx.runId}] approaching the run deadline, asking for a final answer now`);
      void currentAbort?.();
    }, ctx.timeoutMs - wrapUpReserveMs) : undefined;
  softDeadline?.unref();

  // A tool-call ceiling says nothing about how much heap a single turn's own context/output grows
  // by. A runaway turn can hit no tool at all and still climb straight to a V8 OOM crash, which is
  // a hard process abort (not a catchable rejection): no comment update, no cleanup, no log line
  // beyond V8's own stack dump. Sampling heap usage and aborting the attempt ourselves, well before
  // that ceiling, is what turns that into a reported failure instead of a silently stuck "working..."
  // comment. See `describeFatal` below for how this becomes a `resource_exhausted` outcome.
  let abortedForResourceLimit = false;
  let heapWarned = false;
  log(`[${ctx.runId}] heap limit ${heapUsageRatio().limitMb} MB`);
  const heapWatchdog = setInterval(() => {
    const { ratio, usedMb, limitMb } = heapUsageRatio();
    if (ratio >= HEAP_ABORT_RATIO) {
      if (abortedForResourceLimit) return;
      abortedForResourceLimit = true;
      warn(
        `heap usage hit ${Math.round(ratio * 100)}% of the limit (${usedMb} MB / ${limitMb} MB). ` +
          'Aborting this attempt before it crashes the process.',
      );
      void currentAbort?.();
    } else if (ratio >= HEAP_WARN_RATIO && !heapWarned) {
      heapWarned = true;
      log(`heap usage at ${Math.round(ratio * 100)}% of the limit (${usedMb} MB / ${limitMb} MB)`);
    }
  }, HEAP_CHECK_INTERVAL_MS);

  const truncate = (value: unknown, max = 300): string => {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (s === undefined) return 'undefined';
    return s.length > max ? `${s.slice(0, max)}...(${s.length} chars)` : s;
  };

  let lastTurnError = '';
  const unsubscribe = observe((event) => {
    const e = event as FlueEvent;

    // Any event carrying a serialized error, not just `turn`: a `turn` failure reports `isError` with
    // a null `error`, and the provider's status only appears on the `operation` and
    // `submission_settled` events. Keep the latest, which is the one that ended the attempt.
    if ('error' in e && e.error) lastTurnError = describeTurnError(e.error);

    switch (e.type) {
      case 'tool_start': {
        toolStarts += 1;
        // A hand-picked field per tool, so the log says which command ran and which file was touched.
        // The full argument object stays behind `debug`: it carries file contents.
        const summary = summarizeToolArgs(e.toolName, e.args);
        const line = summary ? `${e.toolName} ${summary}` : e.toolName;
        noteActivity(`tool ${line}`);
        log(`[${ctx.runId}] tool_start ${line}`);
        debug(() => `[${ctx.runId}] tool_start ${e.toolName} args=${truncate(e.args)}`);
        if (!hasMaxTurns || !currentAbort) return;
        // The tool that ends the turn is never the one the budget cuts off. Aborting a `submit`
        // throws away a finished answer one call from landing, and it is the call every budget
        // path is trying to reach.
        if (TERMINAL_TOOLS.has(e.toolName)) return;
        // Once the wrap-up is in flight the budget stops applying: the reserve exists so the final
        // answer can be produced, and submitting it is itself a tool call. `WRAP_UP_TIMEOUT_MS` bounds
        // this instead — without it the wrap-up aborts itself and the partial answer is lost.
        if (wrapUpRequested) return;
        if (toolStarts > maxTurns) {
          abortedForMaxTurns = true;
          void currentAbort();
        } else if (softLimit < maxTurns && toolStarts > softLimit) {
          wrapUpRequested = true;
          void currentAbort();
        }
        return;
      }
      case 'tool':
        log(`[${ctx.runId}] tool ${e.toolName} ${e.isError ? 'failed' : 'ok'} in ${e.durationMs}ms`);
        debug(() => `[${ctx.runId}] tool ${e.toolName} result=${truncate(e.result)}`);
        return;
      case 'turn_start':
        noteActivity(`turn ${e.turnId} on ${currentModel}`);
        log(`[${ctx.runId}] turn_start ${e.turnId} purpose=${e.purpose} model=${currentModel}`);
        return;
      case 'turn': {
        const usage = e.response.usage;
        const usageStr = usage
          ? `in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`
          : 'no usage';
        log(
          `[${ctx.runId}] turn ${e.turnId} purpose=${e.purpose} model=${e.request.requestedModel} ${e.durationMs}ms ` +
            `${e.isError ? 'ERROR' : 'ok'} ${usageStr}`,
        );
        const { thinking, text } = readAssistantContent(e.response.output);
        if (thinking) group(`thinking ${e.turnId}`, thinking);
        if (text) log(`[${ctx.runId}] said ${truncate(text, 600)}`);
        return;
      }
      case 'task_start':
        log(`[${ctx.runId}] task_start ${e.taskId} agent=${e.agent ?? '(default)'}`);
        debug(() => `[${ctx.runId}] task_start ${e.taskId} prompt=${truncate(e.prompt, 200)}`);
        return;
      case 'task':
        log(`[${ctx.runId}] task ${e.taskId} agent=${e.agent ?? '(default)'} ${e.durationMs}ms ${e.isError ? 'ERROR' : 'ok'}`);
        return;
      case 'compaction_start':
        log(`[${ctx.runId}] compaction started: reason=${e.reason} estimatedTokens=${e.estimatedTokens}`);
        return;
      case 'compaction':
        log(
          `[${ctx.runId}] compaction finished: ${e.messagesBefore}→${e.messagesAfter} messages in ${e.durationMs}ms` +
            (e.isError ? ` ERROR ${truncate(e.error)}` : ''),
        );
        return;
      case 'submission_settled':
        if (e.outcome !== 'completed') {
          warn(`[${ctx.runId}] submission ${e.submissionId} settled ${e.outcome}: ${e.error?.message ?? '(no message)'}`);
        } else {
          debug(() => `[${ctx.runId}] submission ${e.submissionId} settled completed`);
        }
        return;
      case 'submission_recovery':
        warn(`[${ctx.runId}] submission recovery: ${e.operation} → ${e.outcome}${e.error ? `: ${e.error.message}` : ''}`);
        return;
      case 'log':
        if (typeof e.message === 'string' && e.message.includes('flue:model-retry')) {
          // A retry is the one place the provider's own reason is on a `log` event rather than on the
          // `error` field read above, so it needs its own hop out of the attributes. Recorded as
          // `lastTurnError` too: if the retry itself then fails opaquely, this is what lets the fallback
          // chain classify the attempt on the failure that actually started it.
          const retry = parseModelRetry(e.attributes);
          if (retry.detail) lastTurnError = retry.detail;
          transientRetries += 1;
          log(
            `[${ctx.runId}] model retry ${retry.attempt ?? '?'}/${retry.maxRetries ?? '?'} on ${currentModel} ` +
              `after ${retry.delayMs ?? 0}ms: ${retry.detail || '(no detail)'}`,
          );
          postRateLimited({
            mode: input.mode,
            provider: providerOf(currentModel),
            nextModel: currentModel,
            switching: false,
            ...(retry.attempt !== undefined ? { attempt: retry.attempt } : {}),
            ...(retry.delayMs !== undefined ? { waitSeconds: retry.delayMs / 1000 } : {}),
          });
        } else {
          debug(() => `[${ctx.runId}] flue log[${e.level}]: ${e.message}`);
        }
        return;
      default:
        return;
    }
  });

  const validateContext: ValidateContext | undefined = input.validation
    ? {
        changedPaths: input.validation.changedPaths,
        anchorable: expandCommentableLines(input.validation.anchorable),
        cwd: ctx.cwd,
        ...(input.validation.subjectKind ? { subjectKind: input.validation.subjectKind } : {}),
        ...(input.validation.threadIds ? { threadIds: input.validation.threadIds } : {}),
        ...(input.validation.verifyCommands ? { verifyCommands: input.validation.verifyCommands } : {}),
      }
    : undefined;

  /** Pull the submitted answer out of the reply's data parts. Absent means the model never submitted. */
  const readResult = (data: Record<string, unknown[]> | undefined): JsonValue | undefined =>
    data?.result?.at(-1) as JsonValue | undefined;

  /**
   * One turn on one instance. Everything that makes a turn a turn lives here (the budget, the
   * wrap-up, the submit nudges, the repair pass), so that {@link runOnce} is left deciding only
   * whether the instance itself is worth replacing.
   */
  const runAttempt = async (model: string, instanceId: string): Promise<AttemptResult> => {
    currentModel = model;
    toolStarts = 0;
    lastTurnError = '';
    abortedForMaxTurns = false;
    wrapUpRequested = false;

    // A fresh instance per attempt, so a rate-limited attempt is never carried into the retry's
    // context. This is what `harness.session('crabd-fallback-N')` bought in flue 1; `harness.prompt`
    // would have continued one scratch conversation instead.
    const handle = init(CrabdTurn, { id: instanceId });
    currentAbort = () => handle.abort();

    const creation: TurnCreation = { mode: input.mode, model, instructions: input.instructions };

    // Images ride along as user-message attachments. flue 1 passed them to `harness.prompt({ images })`;
    // a delivered message carries them itself, which is why they have to be fetched before dispatch.
    const receipt = await handle.dispatch({
      message: {
        kind: 'user',
        body: input.message,
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      initialData: creation,
    });
    let reply;
    try {
      reply = await handle.read(receipt, deadline ? { signal: deadline } : undefined);
    } catch (error) {
      // The budget observer aborted mid-turn. A soft abort still has a wrap-up left: ask the same
      // instance, which keeps everything it read, for its best current answer.
      if (wrapUpRequested && !abortedForMaxTurns) {
        try {
          const wrapReceipt = await handle.dispatch(WRAP_UP_INSTRUCTION);
          const wrapped = await handle.read(wrapReceipt, { signal: boundedSignal(WRAP_UP_TIMEOUT_MS, deadline) });
          const data = readResult(wrapped.data);
          if (data !== undefined) return { data, model, partial: true };
        } catch {
          // Wrap-up failed: fall through to normal max_turns handling.
        }
        // A wrap-up the clock asked for must not be reported as a turn-budget failure.
        if (abortedForTimeout || !hasMaxTurns) throw new Error('crabd: the run timed out before it could answer');
        abortedForMaxTurns = true;
        throw new Error(`crabd: max_turns (${maxTurns}) exceeded`);
      }
      // Join the provider's reason onto the opaque rejection so the fallback chain can classify it.
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(lastTurnError ? `${reason} | ${lastTurnError}` : reason);
    }

    let data = readResult(reply.data);
    // flue 1's `result` option re-prompted up to 32 times until the model called `finish`. A terminal
    // tool has no framework loop behind it, so nudge a bounded number of times before giving up.
    for (let nudge = 0; data === undefined && nudge < MAX_SUBMIT_NUDGES; nudge++) {
      try {
        const nudged = await handle.dispatch(SUBMIT_NUDGE);
        data = readResult((await handle.read(nudged)).data);
      } catch {
        break;
      }
    }
    if (data === undefined) throw new Error('crabd: the model never called submit');
    return await repair(handle, model, { data, model });
  };

  /**
   * One position in the fallback chain. A harness-level failure says nothing about the model, so
   * spending a chain position on it (and demoting the run to a weaker fallback, or exhausting the
   * chain outright) answers the wrong question: the conversation is what has to be replaced. Hence a
   * bounded re-run here, on the same model. It does cost a whole turn over again, which is worth it
   * only against the alternative, where the finished review is discarded and the check fails.
   */
  const runOnce = async (model: string, index: number): Promise<AttemptResult> => {
    for (let retry = 0; ; retry++) {
      const instanceId = retry === 0 ? `${ctx.runId}-${index}` : `${ctx.runId}-${index}r${retry}`;
      try {
        return await runAttempt(model, instanceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (retry >= MAX_HARNESS_RETRIES || !isHarnessRecoveryFailure(message)) throw error;
        log(`the harness could not resume the conversation (${message}), re-running the turn on a fresh instance`);
      }
    }
  };

  /**
   * Give the model a bounded chance to fix an answer that is well-formed but unpostable — a finding
   * anchored outside every hunk, a path that isn't in the diff. Dispatched to the *same* instance so
   * it still has everything it read, which is what makes this cheap. Entirely best-effort: any
   * failure keeps the answer we already have rather than losing the review.
   */
  async function repair(
    handle: ReturnType<typeof init>,
    model: string,
    first: AttemptResult,
  ): Promise<AttemptResult> {
    if (!mode?.validate || !validateContext) return first;
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
        const receipt = await handle.dispatch(verdict.repairPrompt);
        const reply = await handle.read(receipt, { signal: boundedSignal(REPAIR_TIMEOUT_MS, deadline) });
        const data = readResult(reply.data);
        if (data === undefined) return current;
        current = { ...current, data };
      } catch {
        // Timed out, hit the turn ceiling, or the instance refused — keep what we had. The finalize
        // path still demotes anything unpostable rather than dropping it.
        return current;
      }
    }
    return current;
  }

  // Fetched once, not per attempt: a fallback re-sends the same images.
  const attachments = await fetchImages(input.images ?? [], ctx.forgeToken);

  let outcome;
  try {
    outcome = await runWithFallback<AttemptResult>({
      chain,
      triggerScope: rl.triggerScope,
      backoff: rl.backoff,
      maxWaitMs,
      runOnce,
      // A deliberate abort must not be mistaken for a rate limit, and a run past its deadline must
      // not walk to the next model in the chain and start again.
      isFatal: () => abortedForMaxTurns || abortedForResourceLimit || abortedForTimeout,
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: describeFatal(
        message,
        abortedForMaxTurns,
        abortedForResourceLimit,
        abortedForTimeout,
        hasMaxTurns ? maxTurns : undefined,
        ctx.timeoutMs,
      ),
    };
  } finally {
    clearInterval(heapWatchdog);
    clearTimeout(softDeadline);
    unsubscribe();
  }

  if (!outcome.ok) {
    const error: Record<string, JsonValue> = {
      kind: 'rate_limited',
      message: outcome.lastError,
      attempts: outcome.attempts,
    };
    if (outcome.lastModel) error.lastModel = outcome.lastModel;
    if (transientRetries > 0) error.providerRetries = transientRetries;
    return { ok: false, error };
  }

  const usedModel = outcome.result.model ?? outcome.model;
  const meta: Record<string, JsonValue> = { modelUsed: usedModel };
  if (outcome.fellBack) meta.fellBackFrom = primaryModel;
  if (outcome.result.partial) meta.partial = true;

  let data = outcome.result.data;
  const verified = await verifyFindings({
    data,
    mode: input.mode,
    model: usedModel,
    partial: outcome.result.partial === true,
    ...(ctx.thinkingLevel ? { thinking: ctx.thinkingLevel } : {}),
    onProgress: (summary) => {
      if (!target) return;
      target.adapter.updateTrackingComment(target.tracking, renderProgress(brand, input.mode, summary)).catch(() => {});
    },
  });
  if (verified) {
    data = verified.data;
    meta.verified = verified.confirmed;
    meta.refuted = verified.refuted;
  }

  return { ok: true, data, meta };
}

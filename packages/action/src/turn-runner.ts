import { getHeapStatistics } from 'node:v8';
import { init, observe, type JsonValue } from '@flue/runtime';
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

function log(message: string): void {
  process.stderr.write(`[crabd] ${message}\n`);
}

/** Like {@link log}, but also surfaces the message as a GitHub Actions warning annotation. */
function warn(message: string): void {
  if (process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::warning::[crabd] ${message}\n`);
  process.stderr.write(`[crabd] ${message}\n`);
}

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
  validation?: { changedPaths: string[]; anchorable: { path: string; ranges: string[] }[] };
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

export function describeFatal(
  message: string,
  maxTurnsHit: boolean,
  resourceExhausted: boolean,
  maxTurns?: number,
  timeoutMs?: number,
): Record<string, JsonValue> {
  if (resourceExhausted) return { kind: 'resource_exhausted', message };
  if (maxTurnsHit) return { kind: 'max_turns', message, ...(maxTurns ? { maxTurns } : {}) };
  const m = message.toLowerCase();
  if (m.includes('timeout') || m.includes('timed out')) {
    const minutes = timeoutMs ? timeoutMs / 60_000 : undefined;
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
  const maxWaitMs = Math.max(0, rl.maxWaitSeconds) * 1000;

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
  let currentModel = primaryModel;
  let currentAbort: (() => Promise<void>) | undefined;
  let abortedForMaxTurns = false;
  let wrapUpRequested = false;

  // A tool-call ceiling says nothing about how much heap a single turn's own context/output grows
  // by. A runaway turn can hit no tool at all and still climb straight to a V8 OOM crash, which is
  // a hard process abort (not a catchable rejection): no comment update, no cleanup, no log line
  // beyond V8's own stack dump. Sampling heap usage and aborting the attempt ourselves, well before
  // that ceiling, is what turns that into a reported failure instead of a silently stuck "working..."
  // comment. See `describeFatal` below for how this becomes a `resource_exhausted` outcome.
  let abortedForResourceLimit = false;
  let heapWarned = false;
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

  let lastTurnError = '';
  const unsubscribe = observe((event) => {
    const e = event as unknown as {
      type: string;
      message?: string;
      isError?: boolean;
      error?: unknown;
      attributes?: unknown;
    };
    // Any event carrying a serialized error, not just `turn`: a `turn` failure reports `isError` with
    // a null `error`, and the provider's status only appears on the `operation` and
    // `submission_settled` events. Keep the latest, which is the one that ended the attempt.
    if (e.error) lastTurnError = describeTurnError(e.error);
    if (e.type === 'tool_start') {
      toolStarts += 1;
      if (!hasMaxTurns || !currentAbort) return;
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
    if (e.type === 'log' && typeof e.message === 'string' && e.message.includes('flue:model-retry')) {
      // A retry is the one place the provider's own reason is on a `log` event rather than on the
      // `error` field read above, so it needs its own hop out of the attributes. Recorded as
      // `lastTurnError` too: if the retry itself then fails opaquely, this is what lets the fallback
      // chain classify the attempt on the failure that actually started it.
      const detail = retryErrorDetail(e.attributes);
      if (detail) {
        lastTurnError = detail;
        log(`model retry: ${detail}`);
      }
      postRateLimited({ mode: input.mode, provider: providerOf(currentModel), switching: false });
    }
  });

  const validateContext: ValidateContext | undefined = input.validation
    ? {
        changedPaths: input.validation.changedPaths,
        anchorable: expandCommentableLines(input.validation.anchorable),
        cwd: ctx.cwd,
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
      reply = await handle.read(receipt);
    } catch (error) {
      // The budget observer aborted mid-turn. A soft abort still has a wrap-up left: ask the same
      // instance, which keeps everything it read, for its best current answer.
      if (wrapUpRequested && !abortedForMaxTurns) {
        try {
          const wrapReceipt = await handle.dispatch(WRAP_UP_INSTRUCTION);
          const wrapped = await handle.read(wrapReceipt, { signal: AbortSignal.timeout(WRAP_UP_TIMEOUT_MS) });
          const data = readResult(wrapped.data);
          if (data !== undefined) return { data, model, partial: true };
        } catch {
          // Wrap-up failed: fall through to normal max_turns handling.
        }
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
        const reply = await handle.read(receipt, { signal: AbortSignal.timeout(REPAIR_TIMEOUT_MS) });
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
      // A deliberate max_turns or resource-limit abort must not be mistaken for a rate limit.
      isFatal: () => abortedForMaxTurns || abortedForResourceLimit,
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
        hasMaxTurns ? maxTurns : undefined,
        ctx.timeoutMs,
      ),
    };
  } finally {
    clearInterval(heapWatchdog);
    unsubscribe();
  }

  if (!outcome.ok) {
    const error: Record<string, JsonValue> = {
      kind: 'rate_limited',
      message: outcome.lastError,
      attempts: outcome.attempts,
    };
    if (outcome.lastModel) error.lastModel = outcome.lastModel;
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

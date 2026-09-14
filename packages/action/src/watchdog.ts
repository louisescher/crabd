import { Worker } from 'node:worker_threads';

/** How often the main thread posts a heartbeat, and how often the worker checks for one. */
const BEAT_MS = 1_000;
/** Silence beyond this means the main thread is inside a synchronous call and nothing else can log. */
const STALL_MS = 20_000;
/** How often the worker repeats itself while a stall or a high-memory condition continues. */
const REPEAT_MS = 30_000;
/** Fraction of the heap ceiling at which resident memory is worth a line of its own. */
const RSS_WARN_RATIO = 0.7;

export interface Watchdog {
  /** Name the work in flight, so a stall report can say what was running. */
  note(label: string): void;
  stop(): Promise<void>;
}

export interface WatchdogOptions {
  /** V8's heap ceiling for the main thread, which the worker cannot read for itself. */
  heapLimitMb: number;
}

/**
 * The worker's whole job, as source text because it runs on its own thread.
 *
 * A worker's `process.stderr` is a shim that forwards through the parent's event loop, so its
 * output would appear only once the main thread is free again, which is never in the case this
 * exists for. `fs.writeSync(2, ...)` writes the file descriptor and reaches the Actions log
 * immediately.
 */
const WORKER_SOURCE = `
// This source is evaluated as whatever module type the parent bundle is, and a dynamic import is
// the one form that works in both.
Promise.all([import('node:worker_threads'), import('node:fs')]).then(([threads, fs]) => {
  const { parentPort, workerData } = threads;
  const { stallMs, repeatMs, beatMs, rssWarnMb } = workerData;
  let last = Date.now();
  let label = 'startup';
  // One throttle per condition, so a steady high-memory line cannot swallow the stall report that
  // arrives later. The stall is the one worth waking up for.
  let stallReportedAt = 0;
  let memoryReportedAt = 0;

  parentPort.on('message', (beat) => {
    last = beat.at;
    label = beat.label;
  });

  const say = (text) => fs.writeSync(2, '[crabd] ' + text + '\\n');
  const due = (at) => !at || Date.now() - at >= repeatMs;

  setInterval(() => {
    const stalledFor = Date.now() - last;
    const rssMb = Math.round(process.memoryUsage.rss() / 1048576);
    if (stalledFor >= stallMs) {
      if (!due(stallReportedAt)) return;
      stallReportedAt = Date.now();
      say('the main thread has not responded for ' + Math.round(stalledFor / 1000) + 's during ' + label + ', rss ' + rssMb + ' MB');
      return;
    }
    stallReportedAt = 0;
    if (rssMb < rssWarnMb) {
      memoryReportedAt = 0;
      return;
    }
    if (!due(memoryReportedAt)) return;
    memoryReportedAt = Date.now();
    say('resident memory ' + rssMb + ' MB during ' + label);
  }, beatMs);
});
`;

/**
 * A memory and stall reporter on its own thread.
 *
 * The in-process heap watchdog samples on the event loop, so the one failure it cannot see is the
 * one that killed run 34819067005: a synchronous allocation that climbs from a healthy heap to the
 * V8 ceiling without ever yielding. No timer fires, no `log()` runs, and the Actions log ends on
 * whatever line was written before the stall. A worker has its own event loop, so it keeps
 * reporting through exactly that window, and the last line before the abort names both the memory
 * in use and the activity that was running.
 *
 * Returns a no-op handle when worker threads are unavailable, because a diagnostic must never be
 * the thing that stops a run from happening.
 */
export function startWatchdog({ heapLimitMb }: WatchdogOptions): Watchdog {
  let label = 'startup';

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        stallMs: STALL_MS,
        repeatMs: REPEAT_MS,
        beatMs: BEAT_MS,
        rssWarnMb: Math.round(heapLimitMb * RSS_WARN_RATIO),
      },
    });
  } catch {
    return { note: () => {}, stop: async () => {} };
  }
  worker.unref();
  worker.on('error', () => {});

  const send = (): void => {
    try {
      worker.postMessage({ at: Date.now(), label });
    } catch {
      // The worker is gone. The run carries on without the reporter.
    }
  };
  const beat = setInterval(send, BEAT_MS);
  beat.unref();

  const watchdog: Watchdog = {
    note: (next) => {
      label = next;
      // Sent straight away, so work that blocks the thread within the same second is named correctly.
      send();
    },
    stop: async () => {
      clearInterval(beat);
      active = undefined;
      await worker.terminate();
    },
  };
  active = watchdog;
  return watchdog;
}

let active: Watchdog | undefined;

/**
 * Name the work in flight on whichever watchdog is running. A free function because the callers are
 * the runtime's event observer, which has no reason to know whether diagnostics are on at all.
 */
export function noteActivity(label: string): void {
  active?.note(label);
}

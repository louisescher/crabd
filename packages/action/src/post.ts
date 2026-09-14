import { renderCrashNotice, renderFailure, RUNNING_MARKER, type FailureKind } from '@crabd/core';
import { describeFatalReport, readFatalReport, type FatalReport } from './fatal-report.ts';
import { buildForge, detectForge } from './forge-factory.ts';
import { log, warn } from './logger.ts';
import { readRunState, type RunState } from './run-state.ts';

/** What the tracking comment should say, given whatever the dead process left behind. */
function classify(report: FatalReport | undefined): { kind: FailureKind; detail?: string } {
  if (!report) return { kind: 'crashed' };
  if (report.outOfMemory) {
    const heap =
      report.heapUsedMb !== undefined && report.heapLimitMb !== undefined
        ? `Heap in use was ${report.heapUsedMb} MB of a ${report.heapLimitMb} MB limit.`
        : undefined;
    return { kind: 'resource_exhausted', detail: [report.reason, heap].filter(Boolean).join(' ') };
  }
  return { kind: 'crashed', detail: report.reason };
}

/**
 * Leave the standalone comment that reaches a person. Editing the tracking comment above notifies
 * nobody, so a run that dies silently stays silent without this. A review-comment trigger gets a
 * threaded reply, everything else gets a comment on the subject.
 */
async function postNotice(
  adapter: Awaited<ReturnType<typeof buildForge>>['adapter'],
  state: RunState,
  kind: FailureKind,
): Promise<void> {
  const body = renderCrashNotice(state.branding, {
    mode: state.mode,
    kind,
    ...(state.trigger?.actor ? { actor: state.trigger.actor } : {}),
  });
  const trigger = state.trigger;
  if (trigger?.kind === 'review' && trigger.commentId !== undefined) {
    await adapter.replyToReviewComment(state.subject, trigger.commentId, body);
    return;
  }
  await adapter.createTrackingComment(state.subject, body);
}

/**
 * Reports a run that crashed or got cancelled before it could update its own tracking comment.
 * Never fails the job: a post step that turns a green run red would be worse than the silence.
 */
export async function post(): Promise<number> {
  const state = readRunState();
  if (!state) return 0;
  if (state.finalized) return 0;

  // Written by `--report-on-fatalerror` into the runner temp directory both containers mount, which
  // is the only thing a V8 abort leaves behind: it takes the process down with no chance to log.
  const report = readFatalReport();
  if (report) log(describeFatalReport(report));
  const { kind, detail } = classify(report);

  try {
    const { adapter } = buildForge(detectForge(), state.repo);

    // The marker check covers the window between updating the comment and recording that it did.
    const current = await adapter.findTrackingComment(state.subject);
    if (!current) return 0;
    if (current.body && !current.body.includes(RUNNING_MARKER)) return 0;

    await adapter.updateTrackingComment(
      { id: state.tracking.id, target: state.tracking.target },
      renderFailure(state.branding, {
        mode: state.mode,
        kind,
        ...(detail ? { detail } : {}),
        ...(state.triggerPhrase ? { triggerPhrase: state.triggerPhrase } : {}),
      }),
    );
    log('the run ended without reporting a result, so the tracking comment was updated from the post step');

    try {
      await postNotice(adapter, state, kind);
    } catch (error) {
      warn(`could not reply to the trigger: ${error instanceof Error ? error.message : String(error)}`);
    }
  } catch (error) {
    warn(`could not report the unfinished run: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

post()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));

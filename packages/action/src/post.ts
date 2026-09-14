import { renderFailure, RUNNING_MARKER } from '@crabd/core';
import { buildForge, detectForge } from './forge-factory.ts';
import { log, warn } from './logger.ts';
import { readRunState } from './run-state.ts';

/**
 * Reports a run that crashed or got cancelled before it could update its own tracking comment.
 * Never fails the job: a post step that turns a green run red would be worse than the silence.
 */
export async function post(): Promise<number> {
  const state = readRunState();
  if (!state) return 0;
  if (state.finalized) return 0;

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
        kind: 'crashed',
        ...(state.triggerPhrase ? { triggerPhrase: state.triggerPhrase } : {}),
      }),
    );
    log('the run ended without reporting a result, so the tracking comment was updated from the post step');
  } catch (error) {
    warn(`could not report the unfinished run: ${error instanceof Error ? error.message : String(error)}`);
  }
  return 0;
}

post()
  .then((code) => process.exit(code))
  .catch(() => process.exit(0));

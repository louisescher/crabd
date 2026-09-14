import { appendFileSync, readFileSync } from 'node:fs';
import type { CommentContext, ForgeKind, ForgeRepo } from '@crabd/core';

/**
 * What the action's post step needs to finish a run that never finished itself. Survives in the
 * runner's state file, which means no secrets: `STATE_*` values are not masked in logs.
 */
export interface RunState {
  version: 1;
  forge: ForgeKind;
  repo: ForgeRepo;
  tracking: { id: number; target: number };
  subject: number;
  mode: string;
  branding: CommentContext;
  triggerPhrase?: string;
  /**
   * What set the run off, so a crash can answer it directly. Editing the tracking comment notifies
   * nobody, which is why a dead run needs a comment of its own.
   */
  trigger?: {
    /** The comment crab'd was replying to, absent when the run came from an event with no comment. */
    commentId?: number;
    /** `review` means the trigger was an inline review comment, which takes a threaded reply. */
    kind: 'issue' | 'review';
    /** Login to address the notice to. */
    actor?: string;
  };
  finalized: boolean;
}

const STATE_KEY = 'crabd';

/**
 * Record the run's state for the post step. Later writes of the same key win, so calling this
 * again with `finalized: true` is how a run says it already reported.
 */
export function saveRunState(state: RunState, env: NodeJS.ProcessEnv = process.env): void {
  const value = JSON.stringify(state);
  const file = env.GITHUB_STATE;
  if (!file) {
    // Older runners, and Forgejo, only understand the deprecated ::save-state command.
    process.stdout.write(`::save-state name=${STATE_KEY}::${value}\n`);
    return;
  }
  const delimiter = `crabd_state_${Math.abs(hashCode(value))}`;
  appendFileSync(file, `${STATE_KEY}<<${delimiter}\n${value}\n${delimiter}\n`);
}

/** The state the main process recorded, or `undefined` when it never got far enough to record one. */
export function readRunState(env: NodeJS.ProcessEnv = process.env): RunState | undefined {
  const raw = env[`STATE_${STATE_KEY}`];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as RunState;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The last value written for a key in a `GITHUB_STATE` file, for tests and for a runner replay. */
export function readStateFile(path: string): string | undefined {
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
  const lines = content.split('\n');
  let found: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(new RegExp(`^${STATE_KEY}<<(.+)$`));
    if (!header) continue;
    const delimiter = header[1];
    const body: string[] = [];
    for (let j = i + 1; j < lines.length && lines[j] !== delimiter; j++) body.push(lines[j] ?? '');
    found = body.join('\n');
  }
  return found;
}

function hashCode(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) | 0;
  return hash;
}

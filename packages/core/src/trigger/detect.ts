import type { ForgeEvent } from '../forge/types.ts';

/** The three built-in modes. Custom modes may be added to the registry. */
export const BUILTIN_MODES = ['mention', 'review', 'implement'] as const;

export interface TriggerResult {
  mode: string;
  /**
   * Free-text the user wrote after the mention (and after any mode keyword).
   * Threaded into every mode so `/crabd review focus on the migration` actually steers.
   */
  userInstruction?: string;
  /**
   * True when the mode was determined unambiguously — a mode keyword in the mention
   * (`/crabd review`) or an event that maps to exactly one mode (a PR opened → review).
   * False only for a bare mention that fell back to `mention`: the caller may run a cheap
   * classifier to route it to the mode the user actually meant ("please review again" →
   * review) instead of answering with a single comment. See {@link prepareRun}.
   */
  explicit: boolean;
}

export interface DetectOptions {
  triggerPhrase: string;
  /** Modes enabled in the resolved config. A detected mode that is disabled yields no trigger. */
  enabledModes: ReadonlySet<string>;
  /**
   * All registered mode names, used to recognize a mention keyword. An explicitly-named
   * but disabled mode is then gated out (no trigger) rather than silently becoming a
   * mention. Defaults to {@link enabledModes}.
   */
  knownModes?: ReadonlySet<string>;
}

/** Locate the trigger phrase in a comment body and return the text following it. */
function afterPhrase(body: string, phrase: string): string | null {
  const index = body.toLowerCase().indexOf(phrase.toLowerCase());
  if (index === -1) return null;
  return body.slice(index + phrase.length).trim();
}

/**
 * If the mention starts with an enabled mode name (built-in or custom), select that
 * mode and treat the rest as the instruction. This is how `/crabd triage …` reaches a
 * custom `triage` mode — any registered mode name works, not just review/implement.
 */
function splitModeKeyword(rest: string, modes: ReadonlySet<string>): { mode?: string; instruction: string } {
  const match = /^([\w-]+)([\s\S]*)$/.exec(rest);
  if (!match) return { instruction: rest };
  const [, word = '', tail = ''] = match;
  const canonical = [...modes].find((m) => m.toLowerCase() === word.toLowerCase());
  if (canonical) return { mode: canonical, instruction: tail.trim() };
  return { instruction: rest };
}

/**
 * Decide which mode (if any) an event triggers, and extract any post-mention
 * instruction. Returns `null` when nothing applies or the matched mode is disabled.
 *
 * Rules:
 * - A comment containing the trigger phrase → `mention`, unless it starts with a
 *   mode keyword (`review`/`implement`), which selects that mode. Remaining text
 *   becomes `userInstruction`.
 * - A pull_request opened/reopened/ready_for_review → `review` (NOT on every push/update).
 * - An issue opened/assigned/labeled → `implement`.
 */
export function detectTrigger(event: ForgeEvent, options: DetectOptions): TriggerResult | null {
  const gate = (result: TriggerResult): TriggerResult | null =>
    options.enabledModes.has(result.mode) ? result : null;

  if (event.comment) {
    const rest = afterPhrase(event.comment.body, options.triggerPhrase);
    if (rest === null) return null;
    const { mode, instruction } = splitModeKeyword(rest, options.knownModes ?? options.enabledModes);
    return gate({
      mode: mode ?? 'mention',
      // A matched keyword is an explicit choice; a bare mention is not and may be classified.
      explicit: mode !== undefined,
      userInstruction: instruction.length > 0 ? instruction : undefined,
    });
  }

  if (event.kind === 'pull_request') {
    // Review on open / reopen / un-draft only — not `synchronize` (a push to the PR).
    // To re-review after changes, mention `/crabd review`.
    if (['opened', 'reopened', 'ready_for_review'].includes(event.action)) {
      return gate({ mode: 'review', explicit: true });
    }
    return null;
  }

  if (event.kind === 'issues') {
    if (['opened', 'assigned', 'labeled'].includes(event.action)) {
      return gate({ mode: 'implement', explicit: true });
    }
    return null;
  }

  return null;
}

import { isCrabdPullRequest } from '../forge/ownership.ts';
import type { ForgeEvent } from '../forge/types.ts';
import { isCrabdAuthored } from '../report/tracking.ts';

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
  branchPrefix?: string;
  implementRounds?: boolean;
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
 * Whether a submitted review asks for anything on its own. A review whose only content is inline
 * comments reports an empty body on both forges, and its comments arrive as their own events, so
 * this deliberately does not try to infer them.
 */
function reviewHasSomethingToAct(event: ForgeEvent): boolean {
  const review = event.review;
  if (!review) return false;
  if (review.state === 'changes_requested') return true;
  return review.state === 'commented' && review.body.trim().length > 0;
}

function detectRound(event: ForgeEvent, options: DetectOptions): TriggerResult | null {
  if (options.implementRounds === false) return null;
  if (event.kind !== 'pull_request_review' && event.kind !== 'pull_request_review_comment') return null;
  if (event.kind === 'pull_request_review' && event.action !== 'submitted') return null;
  if (event.kind === 'pull_request_review_comment' && event.action !== 'created') return null;
  if (event.kind === 'pull_request_review' && !reviewHasSomethingToAct(event)) return null;
  if (event.pullRequest?.isDraft) return null;
  if (isCrabdAuthored(event.comment?.body)) return null;
  if (!isCrabdPullRequest(event.pullRequest, options.branchPrefix)) return null;
  return options.enabledModes.has('implement')
    ? { mode: 'implement', explicit: event.kind === 'pull_request_review' }
    : null;
}

/**
 * Decide which mode (if any) an event triggers, and extract any post-mention
 * instruction. Returns `null` when nothing applies or the matched mode is disabled.
 *
 * Rules:
 * - A comment containing the trigger phrase → `mention`, unless it starts with a
 *   mode keyword (`review`/`implement`), which selects that mode. Remaining text
 *   becomes `userInstruction`. Never on a `deleted` comment: GitHub and Forgejo both
 *   still report the removed comment's `body` on that action, so a webhook subscribed
 *   to more than `created` would otherwise replay a mention that no longer exists.
 * - A pull_request opened/reopened/ready_for_review → `review` (NOT on every push/update),
 *   unless the PR is still a draft. A mention in a draft PR still works.
 * - An issue opened/assigned/labeled → `implement`.
 * - A submitted review, or an inline review comment, on a pull request crab'd owns → `implement`,
 *   with no trigger phrase needed, which is how a feedback round starts. Never on crab'd's own
 *   text, recognized by the markers it stamps into everything it writes. Both of these are
 *   GitHub-only in practice: Forgejo Actions has no review events to dispatch on.
 */
export function detectTrigger(event: ForgeEvent, options: DetectOptions): TriggerResult | null {
  const gate = (result: TriggerResult): TriggerResult | null =>
    options.enabledModes.has(result.mode) ? result : null;

  if (event.comment) {
    if (event.action === 'deleted') return null;
    const rest = afterPhrase(event.comment.body, options.triggerPhrase);
    if (rest !== null) {
      const { mode, instruction } = splitModeKeyword(rest, options.knownModes ?? options.enabledModes);
      return gate({
        mode: mode ?? 'mention',
        // A matched keyword is an explicit choice; a bare mention is not and may be classified.
        explicit: mode !== undefined,
        userInstruction: instruction.length > 0 ? instruction : undefined,
      });
    }
    return detectRound(event, options);
  }

  if (event.kind === 'pull_request') {
    // Review on open / reopen / un-draft only — not `synchronize` (a push to the PR).
    // To re-review after changes, mention `/crabd review`.
    if (event.pullRequest?.isDraft) return null;
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

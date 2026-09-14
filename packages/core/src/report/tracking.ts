/** Hidden marker identifying a crab'd tracking comment, for sticky reuse across runs. */
export const TRACKING_MARKER = '<!-- crabd:tracking -->';

/**
 * Hidden marker on every inline review finding crab'd posts.
 *
 * Without it there is no reliable way to tell crab'd's own finding from a human's inline comment
 * when a reply thread is reconstructed: the bot's login is not knowable at runtime (it varies by
 * install — App, broker, or PAT). See `buildReviewThread`.
 */
export const FINDING_MARKER = '<!-- crabd:finding -->';

/**
 * Hidden marker on crab'd's dedicated memory comment, for sticky reuse across runs, same idea as
 * {@link TRACKING_MARKER} but a distinct marker: a memory comment must never satisfy
 * `findTrackingComment(target, TRACKING_MARKER)` or the broad "already commented here" gate in
 * `isCorrectionReply`, both of which key on `TRACKING_MARKER` alone.
 */
export const MEMORY_MARKER = '<!-- crabd:memory -->';

export const PR_MARKER = '<!-- crabd:pr -->';

export const REPLY_MARKER = '<!-- crabd:reply -->';

/**
 * Hidden marker on every non-terminal tracking-comment state, so the action's post step can tell
 * whether a run ever reported an outcome without racing a flag saved from inside the process.
 */
export const RUNNING_MARKER = '<!-- crabd:running -->';

/**
 * Hidden marker on the standalone comment the post step leaves when a run dies without answering.
 * Distinct from {@link TRACKING_MARKER} so the notice is never mistaken for the sticky tracking
 * comment a later run would reuse.
 */
export const CRASH_MARKER = '<!-- crabd:crashed -->';

export const CRABD_MARKERS = [TRACKING_MARKER, FINDING_MARKER, MEMORY_MARKER, PR_MARKER, REPLY_MARKER, CRASH_MARKER];

export function isCrabdAuthored(body: string | undefined): boolean {
  return Boolean(body && CRABD_MARKERS.some((marker) => body.includes(marker)));
}

/** Base URL of the crab'd documentation site, for the actionable links in failure comments. */
const DOCS_BASE = 'https://crabd.lou.gg';

function handledMarker(id: number, kind: HandledKind = 'comment'): string {
  return kind === 'comment' ? `<!-- crabd:handled:${id} -->` : `<!-- crabd:handled:${kind}:${id} -->`;
}

export type HandledKind = 'comment' | 'review' | 'review_comment';

export function isCommentHandled(body: string | undefined, id: number, kind: HandledKind = 'comment'): boolean {
  return Boolean(body?.includes(handledMarker(id, kind)));
}

export function roundMarker(headSha: string, feedbackToken: string): string {
  return `<!-- crabd:round:${headSha}:${feedbackToken} -->`;
}

export function isRoundHandled(body: string | undefined, headSha: string, feedbackToken: string): boolean {
  return Boolean(body?.includes(roundMarker(headSha, feedbackToken)));
}

/** How crab'd presents itself in a tracking comment: the display name, brand emoji, footer. */
export interface Branding {
  /** Display name used in comments (e.g. `crab'd`). */
  name: string;
  /** Brand emoji prefixed to comments; empty string renders no emoji. */
  emoji: string;
  /** Whether the visible `posted by <name>` footer is shown (the hidden marker is always kept). */
  footer: boolean;
}

/** The built-in branding — crab'd's own name, emoji, and footer. */
export const DEFAULT_BRANDING: Branding = { name: "crab'd", emoji: '🦀', footer: true };

/**
 * How crab'd presents itself, plus anything run-scoped it needs to say on every update.
 *
 * Every renderer takes this rather than {@link Branding} so an advisory raised before the run —
 * "memory is on but this token cannot write" — appears on the working comment, each progress
 * update, and the final result alike, without threading a parameter through six signatures.
 * `Branding` is structurally assignable, so a caller with nothing to warn about passes it directly.
 */
export interface CommentContext extends Branding {
  /**
   * Run-scoped warnings, rendered below a rule above the footer. These describe a setting that
   * cannot take effect (rather than a failure), so they are raised up front and repeated on every
   * state — the user should not have to wait for the run to end to learn crab'd can't do something.
   */
  advisories?: string[];
  handledCommentId?: number;
  handledKind?: HandledKind;
  roundClaim?: { headSha: string; feedbackToken: string };
  /** Link to the CI run, rendered on every state. */
  runUrl?: string;
}

/** The emoji prefix (`🦀 `) for a comment lead, or `''` when no emoji is configured. */
function prefix(b: Branding): string {
  return b.emoji ? `${b.emoji} ` : '';
}

/**
 * The advisory block: a rule, then each warning as a GitHub alert so it reads as a warning rather
 * than as more body text. Empty when there is nothing to say, which is the overwhelming default.
 */
function advisoryBlock(b: CommentContext): string {
  const advisories = (b.advisories ?? []).map((a) => a.trim()).filter(Boolean);
  if (advisories.length === 0) return '';
  const blocks = advisories
    .map((a) => `> [!WARNING]\n${a.split('\n').map((line) => `> ${line}`.trimEnd()).join('\n')}`)
    .join('\n\n');
  return `\n\n---\n\n${blocks}`;
}

/**
 * The comment footer. Always ends with {@link TRACKING_MARKER} so crab'd can find and reuse
 * its own comment across runs; the visible `posted by` line (with the attribution link) is
 * omitted when `branding.footer` is false. Any {@link CommentContext.advisories} are rendered
 * immediately above it, so every renderer picks them up from its single existing `footer(...)` call.
 */
function footer(b: CommentContext, running = false): string {
  const advisory = advisoryBlock(b);
  const handled = b.handledCommentId !== undefined ? `\n${handledMarker(b.handledCommentId, b.handledKind)}` : '';
  const round = b.roundClaim ? `\n${roundMarker(b.roundClaim.headSha, b.roundClaim.feedbackToken)}` : '';
  const markers = `${running ? `${RUNNING_MARKER}\n` : ''}${TRACKING_MARKER}${handled}${round}`;
  const link = b.runUrl ? `\n\n<sub>[run logs](${b.runUrl})</sub>` : '';
  if (!b.footer) return `${advisory}${link}\n${markers}`;
  return `${advisory}${link}\n\n<sub>${prefix(b)}posted by [${b.name}](https://github.com/louisescher/crabd)</sub>\n${markers}`;
}

const MODE_VERB: Record<string, string> = {
  mention: 'working on your request',
  review: 'reviewing this pull request',
  implement: 'implementing this issue',
  'implement:round': 'addressing the feedback on this pull request',
};

/** The initial "in progress" tracking comment body. */
export function renderWorking(branding: CommentContext, mode: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  return `${prefix(branding)}**${branding.name}** is ${verb}...${footer(branding, true)}`;
}

/** A live progress update posted mid-run by the agent's progress tool. */
export function renderProgress(branding: CommentContext, mode: string, message: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  return `${prefix(branding)}**${branding.name}** is ${verb}...\n\n${message.trim()}${footer(branding, true)}`;
}

export interface RateLimitedRender {
  mode: string;
  /** Provider that rate-limited us, if known (e.g. `anthropic`). */
  provider?: string;
  /** The model crab'd is about to (re)try. */
  nextModel?: string;
  /** 1-based number of the attempt crab'd is about to make. */
  attempt?: number;
  /** Seconds crab'd will wait before that attempt. */
  waitSeconds?: number;
  /** True when moving to a different (fallback) model rather than retrying the primary. */
  switching?: boolean;
}

/**
 * A live tracking-comment update while crab'd is waiting out / retrying a rate
 * limit or switching to a fallback model.
 */
export function renderRateLimited(branding: CommentContext, render: RateLimitedRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const provider = render.provider ? ` on \`${render.provider}\`` : '';
  const wait = render.waitSeconds && render.waitSeconds > 0 ? ` waiting ~${Math.round(render.waitSeconds)}s, then` : '';
  const target =
    render.switching && render.nextModel
      ? ` switching to fallback model \`${render.nextModel}\``
      : render.nextModel
        ? ` retrying with \`${render.nextModel}\``
        : ' retrying';
  const attempt = render.attempt ? ` (attempt ${render.attempt})` : '';
  return `${prefix(branding)}**${branding.name}** hit a rate limit${provider} while ${verb}:${wait}${target}${attempt}...${footer(branding, true)}`;
}

export interface RateLimitExhaustedRender {
  mode: string;
  /** Number of model attempts crab'd made before giving up. */
  attempts: number;
  /** The last model tried, if known. */
  lastModel?: string;
  /** Same-model retries the provider layer made underneath those attempts, when there were any. */
  providerRetries?: number;
  /** True = crab'd finished the run green (soft); false = it failed the check. */
  soft: boolean;
  /** Trigger phrase to suggest for a manual retry (e.g. `/crabd`). */
  triggerPhrase?: string;
}

/** The tracking comment when every model in the chain was rate-limited / the wait budget ran out. */
export function renderRateLimitExhausted(branding: CommentContext, render: RateLimitExhaustedRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const last = render.lastModel ? ` (last tried \`${render.lastModel}\`)` : '';
  const plural = render.attempts === 1 ? '' : 's';
  const retries = render.providerRetries
    ? `, and ${render.providerRetries} provider retr${render.providerRetries === 1 ? 'y' : 'ies'} underneath them`
    : '';
  const modeKeyword = render.mode === 'mention' ? '' : ` ${render.mode}`;
  const retry = render.triggerPhrase
    ? ` Comment \`${render.triggerPhrase}${modeKeyword}\` to try again once the limits ease.`
    : ' Try again once the rate limits ease.';
  // Status glyphs (⏳/⚠️) mark the outcome and are intentionally not part of brand emoji.
  const lead = render.soft
    ? `⏳ **${branding.name}** couldn't finish ${verb}: every model was rate-limited after ${render.attempts} attempt${plural}${retries}${last}.`
    : `⚠️ **${branding.name}** failed while ${verb}: every model was rate-limited after ${render.attempts} attempt${plural}${retries}${last}.`;
  return `${lead}${retry}${footer(branding)}`;
}

export interface ResultRender {
  mode: string;
  summary: string;
  prUrl?: string;
  /** Optional disclosure line appended as a <sub> note (e.g. a fallback model was used). */
  note?: string;
}

/** The final tracking comment body once the run succeeds. */
export function renderResult(branding: CommentContext, render: ResultRender): string {
  const parts = [render.summary.trim()];
  if (render.prUrl) parts.push(`\n➡️ Opened pull request: ${render.prUrl}`);
  if (render.note) parts.push(`\n<sub>${render.note}</sub>`);
  return parts.join('\n') + footer(branding);
}

/**
 * crab'd's dedicated memory comment: `commitMemories`'s outcome note (committed, skipped, or failed,
 * already carrying its own 🧠 lead, see `commit.ts`), on its own comment rather than folded into the
 * pinned tracking comment. Ends with {@link MEMORY_MARKER}, not {@link TRACKING_MARKER}. It's
 * deliberately not built from {@link footer}, which always embeds the latter.
 */
export function renderMemoryNote(note: string): string {
  return `${note.trim()}\n${MEMORY_MARKER}`;
}

/** The classes of terminal failure crab'd can post a tailored, actionable comment for. */
export type FailureKind =
  | 'max_turns'
  | 'timeout'
  | 'resource_exhausted'
  | 'config'
  | 'network'
  | 'crashed'
  | 'error';

export interface FailureRender {
  mode: string;
  /** What went wrong, so the comment can tailor the cause + fix. Falls back to a generic error. */
  kind: FailureKind;
  /** The underlying error message, shown truncated in a collapsible block. Never a command dump. */
  detail?: string;
  /** Configured tool-call ceiling (`limits.max_turns`), for the max_turns tip. */
  maxTurns?: number;
  /** Configured wall-clock limit in minutes (`limits.timeout_minutes`), for the timeout tip. */
  timeoutMinutes?: number;
  /** Trigger phrase to suggest for a manual retry (e.g. `/crabd`). */
  triggerPhrase?: string;
}

/** Render the underlying error as a collapsed, length-capped detail block (empty when none). */
function detailBlock(detail: string | undefined): string {
  const clean = detail?.trim();
  if (!clean) return '';
  const shown = clean.length > 600 ? `${clean.slice(0, 600)}\n... [truncated]` : clean;
  return `\n\n<details><summary>Error details</summary>\n\n\`\`\`\n${shown}\n\`\`\`\n\n</details>`;
}

/**
 * The tracking comment when a run fails. Unlike a raw stack trace, this explains what
 * happened, what to change (pointing at the specific config knob), and links the docs —
 * tailored per {@link FailureKind}. This is the single renderer behind every error crab'd posts.
 */
export function renderFailure(branding: CommentContext, render: FailureRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const name = branding.name;

  let lead: string;
  let tip: string;
  let docs: string;
  switch (render.kind) {
    case 'max_turns': {
      const limit = render.maxTurns ? ` (${render.maxTurns} turns)` : '';
      lead = `⚠️ **${name}** stopped while ${verb} — it reached the tool-call limit${limit} before finishing.`;
      tip = `This usually means the task was too broad for one run, or ${name} spent turns on things it couldn't complete (for example files or repositories it has no access to). **What to change:** narrow the request — point at specific files or split a large PR — or raise \`limits.max_turns\` if the task genuinely needs more steps.`;
      docs = `[Troubleshooting → run hit the turn limit](${DOCS_BASE}/troubleshooting/#run-hit-the-turn-limit)`;
      break;
    }
    case 'timeout': {
      const limit = render.timeoutMinutes ? ` ${render.timeoutMinutes}-minute` : '';
      lead = `⚠️ **${name}** ran out of time while ${verb} — the run exceeded its${limit} time limit.`;
      tip = `**What to change:** raise \`limits.timeout_minutes\`, or narrow the request so it finishes within the limit.`;
      docs = `[Troubleshooting → run timed out](${DOCS_BASE}/troubleshooting/#run-timed-out)`;
      break;
    }
    case 'resource_exhausted': {
      lead = `⚠️ **${name}** ran out of memory while ${verb}. Its heap usage hit the safety limit before it could finish.`;
      tip = `This usually means the task pulled in unusually large inputs: a very large diff, huge files, or a long-running conversation. **What to change:** narrow the request, split a large PR into smaller ones, or turn off \`context.full_diff\` if it's on.`;
      docs = `[Troubleshooting → run ran out of memory](${DOCS_BASE}/troubleshooting/#run-ran-out-of-memory)`;
      break;
    }
    case 'crashed': {
      lead = `⚠️ **${name}** stopped unexpectedly while ${verb}.`;
      tip = `The run ended before it could finish or report a result. That is usually the job being cancelled, or ${name} running out of memory on an unusually large input. **What to change:** read the run logs below, then narrow the request or split a large pull request.`;
      docs = `[Troubleshooting](${DOCS_BASE}/troubleshooting/)`;
      break;
    }
    case 'config': {
      lead = `⚠️ **${name}** couldn't start ${verb} — its configuration is invalid.`;
      tip = `**What to change:** check your \`.crabd.yml\` / \`crabd.config.ts\` against the reference and fix the reported field.`;
      docs = `[Configuration](${DOCS_BASE}/configuration/)`;
      break;
    }
    case 'network': {
      lead = `⚠️ **${name}** hit a network or provider error while ${verb}.`;
      tip = `This is usually transient. **What to change:** try again in a moment; if it keeps happening, check your provider / gateway settings and keys.`;
      docs = `[Troubleshooting](${DOCS_BASE}/troubleshooting/)`;
      break;
    }
    default: {
      lead = `⚠️ **${name}** hit an error while ${verb}.`;
      tip = `**What to change:** check the details below and your configuration. If this looks like a bug in ${name}, please report it.`;
      docs = `[Troubleshooting](${DOCS_BASE}/troubleshooting/)`;
    }
  }

  const retry = render.triggerPhrase
    ? `Once you've adjusted things, comment \`${render.triggerPhrase}\` to try again.`
    : undefined;
  const parts = [lead, tip, ...(retry ? [retry] : []), `📖 ${docs}`];
  return parts.join('\n\n') + detailBlock(render.detail) + footer(branding);
}

/** The tracking comment body when the run fails. Thin wrapper over {@link renderFailure}. */
export function renderError(branding: CommentContext, mode: string, message: string): string {
  return renderFailure(branding, { mode, kind: 'error', detail: message });
}

/** Short cause line per failure class, for the standalone crash notice. */
const CRASH_CAUSE: Record<FailureKind, string> = {
  max_turns: 'it reached its tool-call limit',
  timeout: 'it ran out of time',
  resource_exhausted: 'it ran out of memory',
  config: 'its configuration is invalid',
  network: 'a network or provider error ended the run',
  crashed: 'the run ended without reporting a result',
  error: 'it hit an error',
};

export interface CrashNoticeRender {
  mode: string;
  kind: FailureKind;
  /** Login to address the notice to, so the person who triggered the run is notified. */
  actor?: string;
}

/**
 * The standalone comment the post step leaves when a run dies without answering. The tracking
 * comment is edited in the same pass, and an edit notifies nobody: this is what reaches the person
 * who asked. Deliberately short, because the tracking comment carries the full explanation.
 */
export function renderCrashNotice(branding: CommentContext, render: CrashNoticeRender): string {
  const verb = MODE_VERB[render.mode] ?? 'working';
  const cause = CRASH_CAUSE[render.kind] ?? CRASH_CAUSE.crashed;
  const mention = render.actor ? `@${render.actor} ` : '';
  const lead = `${mention}${prefix(branding)}**${branding.name}** stopped while ${verb}: ${cause}.`;
  const where = 'Its status comment on this thread has the details and what to change.';
  const link = branding.runUrl ? ` [run logs](${branding.runUrl})` : '';
  return `${lead}\n\n${where}${link}\n${CRASH_MARKER}`;
}

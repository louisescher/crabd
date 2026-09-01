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

/** Base URL of the crab'd documentation site, for the actionable links in failure comments. */
const DOCS_BASE = 'https://crabd.lou.gg';

function handledMarker(commentId: number): string {
  return `<!-- crabd:handled:${commentId} -->`;
}

export function isCommentHandled(body: string | undefined, commentId: number): boolean {
  return Boolean(body?.includes(handledMarker(commentId)));
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
function footer(b: CommentContext): string {
  const advisory = advisoryBlock(b);
  const handled = b.handledCommentId !== undefined ? `\n${handledMarker(b.handledCommentId)}` : '';
  if (!b.footer) return `${advisory}\n${TRACKING_MARKER}${handled}`;
  return `${advisory}\n\n<sub>${prefix(b)}posted by [${b.name}](https://github.com/louisescher/crabd)</sub>\n${TRACKING_MARKER}${handled}`;
}

const MODE_VERB: Record<string, string> = {
  mention: 'working on your request',
  review: 'reviewing this pull request',
  implement: 'implementing this issue',
};

/** The initial "in progress" tracking comment body. */
export function renderWorking(branding: CommentContext, mode: string, runUrl?: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  const link = runUrl ? ` ([logs](${runUrl}))` : '';
  return `${prefix(branding)}**${branding.name}** is ${verb}...${link}${footer(branding)}`;
}

/** A live progress update posted mid-run by the agent's progress tool. */
export function renderProgress(branding: CommentContext, mode: string, message: string): string {
  const verb = MODE_VERB[mode] ?? 'working';
  return `${prefix(branding)}**${branding.name}** is ${verb}...\n\n${message.trim()}${footer(branding)}`;
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
  return `${prefix(branding)}**${branding.name}** hit a rate limit${provider} while ${verb} —${wait}${target}${attempt}…${footer(branding)}`;
}

export interface RateLimitExhaustedRender {
  mode: string;
  /** Number of model attempts crab'd made before giving up. */
  attempts: number;
  /** The last model tried, if known. */
  lastModel?: string;
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
  const modeKeyword = render.mode === 'mention' ? '' : ` ${render.mode}`;
  const retry = render.triggerPhrase
    ? ` Comment \`${render.triggerPhrase}${modeKeyword}\` to try again once the limits ease.`
    : ' Try again once the rate limits ease.';
  // Status glyphs (⏳/⚠️) mark the outcome and are intentionally not part of brand emoji.
  const lead = render.soft
    ? `⏳ **${branding.name}** couldn't finish ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`
    : `⚠️ **${branding.name}** failed while ${verb} — every model was rate-limited after ${render.attempts} attempt${plural}${last}.`;
  return `${lead}${retry}${footer(branding)}`;
}

export interface ResultRender {
  mode: string;
  summary: string;
  prUrl?: string;
  runUrl?: string;
  /** Optional disclosure line appended as a <sub> note (e.g. a fallback model was used). */
  note?: string;
}

/** The final tracking comment body once the run succeeds. */
export function renderResult(branding: CommentContext, render: ResultRender): string {
  const parts = [render.summary.trim()];
  if (render.prUrl) parts.push(`\n➡️ Opened pull request: ${render.prUrl}`);
  if (render.note) parts.push(`\n<sub>${render.note}</sub>`);
  if (render.runUrl) parts.push(`\n<sub>[run logs](${render.runUrl})</sub>`);
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
export type FailureKind = 'max_turns' | 'timeout' | 'resource_exhausted' | 'config' | 'network' | 'error';

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
  /** Link to the run logs, appended as a footer note. */
  runUrl?: string;
}

/** Render the underlying error as a collapsed, length-capped detail block (empty when none). */
function detailBlock(detail: string | undefined): string {
  const clean = detail?.trim();
  if (!clean) return '';
  const shown = clean.length > 600 ? `${clean.slice(0, 600)}\n… [truncated]` : clean;
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
  const runLog = render.runUrl ? `\n<sub>[run logs](${render.runUrl})</sub>` : '';
  const parts = [lead, tip, ...(retry ? [retry] : []), `📖 ${docs}`];
  return parts.join('\n\n') + detailBlock(render.detail) + runLog + footer(branding);
}

/** The tracking comment body when the run fails. Thin wrapper over {@link renderFailure}. */
export function renderError(branding: CommentContext, mode: string, message: string): string {
  return renderFailure(branding, { mode, kind: 'error', detail: message });
}

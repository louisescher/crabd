import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REVIEW_DIMENSIONS } from '@crabd/config';
import * as v from 'valibot';
import { commentableLines, snapToCommentableLine } from '../context/diff-lines.ts';
import { foldCommentsIntoBody } from '../forge/review-body.ts';
import type { ReviewComment } from '../forge/types.ts';
import { FINDING_MARKER } from '../report/tracking.ts';
import type { ModeDefinition, ValidateContext } from './registry.ts';
import { subjectNumber } from './shared.ts';

/** Severity bands, most to least serious. Drives ranking and the verdict contradiction check. */
export const REVIEW_SEVERITIES = ['blocker', 'major', 'minor', 'nit'] as const;
export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];

/** Rank for sorting — lower is more severe. */
const SEVERITY_RANK: Record<ReviewSeverity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

/**
 * How far a mis-anchored finding may be moved onto a legal line before it's demoted to body text.
 * Models miss by a line or two (a closing brace just past the hunk, the declaration above it);
 * losing an otherwise good finding to that is worse than moving it and saying so.
 */
const SNAP_TOLERANCE = 5;

/**
 * One review finding.
 *
 * `path`, `line`, and `body` are the original three fields and keep their meaning, so anything
 * consuming `outputs.result` still works. Everything else was added to make a finding *checkable*:
 * before, the model could emit a confident sentence with no mechanism, no trigger, and no citation,
 * and crab'd had no way to tell that apart from a verified bug.
 *
 * `failureScenario` is the load-bearing field. A finding that cannot name concrete inputs *and* the
 * concrete wrong outcome is exactly the shape a pattern-matched false positive takes, so requiring
 * both halves means the model either does the work or drops the finding. `evidence` is checked
 * against the file on disk in {@link quoteIsReal}; `confidence` is thresholded in {@link finalize}.
 */
export const ReviewFindingSchema = v.object({
  /** New-side path of the file the finding is about. */
  path: v.string(),
  /** New-side line number, which must be one of the anchorable lines shown in the prompt. */
  line: v.number(),
  /** What is wrong and why it matters. */
  body: v.string(),
  /** How serious: `blocker` blocks the merge, `nit` is trivial. */
  severity: v.picklist(REVIEW_SEVERITIES),
  /** Which review dimension this falls under. */
  category: v.picklist(REVIEW_DIMENSIONS),
  /** Compressed one-line claim for the comment heading. */
  shortSummary: v.pipe(v.string(), v.maxLength(120)),
  /** Concrete inputs or state → the concrete wrong result. Both halves required. */
  failureScenario: v.string(),
  /** A `path:line` the model opened, and text copied verbatim from it. */
  evidence: v.object({ location: v.string(), quote: v.string() }),
  /** 1–10. Thresholded against `review.min_confidence` before anything is posted. */
  confidence: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
  /** The concrete fix, when there is one worth stating. */
  recommendation: v.optional(v.string()),
});

export type ReviewFinding = v.InferOutput<typeof ReviewFindingSchema>;

export const ReviewOutputSchema = v.object({
  /** Overall review summary posted as the review body. */
  summary: v.string(),
  /** Review verdict. */
  verdict: v.picklist(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']),
  /** Inline findings anchored to file + line. */
  findings: v.array(ReviewFindingSchema),
});

export type ReviewOutput = v.InferOutput<typeof ReviewOutputSchema>;

/** The verdict as a plain-language sentence (the raw enum is kept for the forge API). */
const VERDICT_LABEL: Record<ReviewOutput['verdict'], string> = {
  APPROVE: 'Good to merge (LGTM)',
  COMMENT: 'Nits found',
  REQUEST_CHANGES: 'Please address the findings before merging',
};

/** Parse `path:line` (or a bare path) out of an evidence location. */
function parseLocation(location: string): { path: string; line?: number } {
  const match = location.match(/^(.*?):(\d+)(?::\d+)?$/);
  if (match?.[1]) return { path: match[1], line: Number(match[2]) };
  return { path: location };
}

/**
 * Whether a finding's evidence quote actually appears in the file it cites.
 *
 * This is the one check that catches a fabricated citation, which is the most damaging kind of
 * false positive: a human clicks through to `path:line`, the code says something else, and the
 * whole review stops being trusted. Compared with whitespace collapsed, since the model retypes
 * rather than byte-copies. A file we cannot read is not evidence of a lie — those pass.
 */
function quoteIsReal(cwd: string, finding: ReviewFinding): boolean {
  const quote = finding.evidence.quote.trim();
  // Nothing to verify against — the confidence and scenario gates still apply.
  if (!quote) return true;

  const { path } = parseLocation(finding.evidence.location);
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const needle = normalize(quote);

  let readAnything = false;
  for (const candidate of [path, finding.path]) {
    if (!candidate) continue;
    let content: string;
    try {
      content = readFileSync(join(cwd, candidate), 'utf-8');
    } catch {
      // Deleted, binary, or outside the checkout — try the next candidate.
      continue;
    }
    readAnything = true;
    if (normalize(content).includes(needle)) return true;
  }
  // Only a file we actually read and did *not* find the quote in is evidence of a fabrication.
  // If nothing could be read we cannot tell, and silently dropping the finding would be worse
  // than posting it — so the benefit of the doubt goes to the finding.
  return !readAnything;
}

/** Sort most severe first, then most confident. Stable enough to be deterministic. */
function rankFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return [...findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.confidence - a.confidence,
  );
}

/**
 * Render a finding into the markdown body of an inline review comment.
 *
 * The trailing {@link FINDING_MARKER} is invisible in the rendered comment and is what lets a later
 * run recognize its own finding at the root of a reply thread — the bot's login varies by install,
 * so the author field cannot answer that question.
 */
function renderFinding(finding: ReviewFinding): string {
  const parts = [`**${finding.severity}** · \`${finding.category}\` — ${finding.shortSummary}`, '', finding.body];
  if (finding.failureScenario.trim()) parts.push('', `**Fails when:** ${finding.failureScenario}`);
  if (finding.recommendation?.trim()) parts.push('', `**Fix:** ${finding.recommendation}`);
  if (finding.evidence.location.trim()) {
    parts.push('', `_Verified at \`${finding.evidence.location}\`._`);
  }
  parts.push('', FINDING_MARKER);
  return parts.join('\n');
}

/** What the gates removed, for an honest one-line note in the review body. */
interface DroppedCounts {
  lowConfidence: number;
  unevidenced: number;
  truncated: number;
}

/**
 * Apply the reporting gates to the model's raw findings.
 *
 * These run in code rather than being left to the prompt on purpose: a model asked to self-censor
 * will rationalise its way past its own threshold, whereas a filter here cannot be argued with. The
 * gates are, in order: drop anything under the confidence floor, drop anything whose evidence quote
 * doesn't exist in the cited file, rank by severity then confidence, and cap the list.
 */
export function applyFindingGates(
  findings: ReviewFinding[],
  options: {
    cwd: string;
    minConfidence: number;
    maxFindings: number;
    /**
     * Whether the files on disk are the change under review. When they are not (a checkout that
     * could not be moved onto the PR head), every quote from an added line is absent from the
     * pre-change file, so the evidence gate would discard the entire review for lying when the
     * only thing wrong is the workspace. Skip it there and let confidence carry the weight.
     */
    verifyQuotes?: boolean;
  },
): { kept: ReviewFinding[]; dropped: DroppedCounts } {
  const dropped: DroppedCounts = { lowConfidence: 0, unevidenced: 0, truncated: 0 };

  const survivors: ReviewFinding[] = [];
  for (const finding of findings) {
    if (finding.confidence < options.minConfidence) {
      dropped.lowConfidence++;
      continue;
    }
    if (options.verifyQuotes !== false && !quoteIsReal(options.cwd, finding)) {
      dropped.unevidenced++;
      continue;
    }
    survivors.push(finding);
  }

  const ranked = rankFindings(survivors);
  const kept = ranked.slice(0, options.maxFindings);
  dropped.truncated = ranked.length - kept.length;
  return { kept, dropped };
}

/** A short, honest note about what was withheld — an aggregate, never the findings themselves. */
function droppedNote(dropped: DroppedCounts): string | undefined {
  const parts: string[] = [];
  if (dropped.lowConfidence > 0) {
    parts.push(`${dropped.lowConfidence} low-confidence observation${dropped.lowConfidence === 1 ? '' : 's'} withheld`);
  }
  if (dropped.unevidenced > 0) {
    parts.push(`${dropped.unevidenced} finding${dropped.unevidenced === 1 ? '' : 's'} discarded for unverifiable citations`);
  }
  if (dropped.truncated > 0) {
    parts.push(`${dropped.truncated} lower-ranked finding${dropped.truncated === 1 ? '' : 's'} not shown`);
  }
  return parts.length > 0 ? `_${parts.join('; ')}._` : undefined;
}

/**
 * Split findings into those a forge can anchor inline (path + line inside a changed hunk) and
 * those that fall outside the diff. GitHub rejects the whole review with 422 "Line could not be
 * resolved" if an inline comment targets a line outside the diff, so out-of-diff findings are
 * kept as text instead. With no diff to check against, everything is treated as inline (the
 * adapter's postReview retains its own fallback for that case).
 *
 * A finding that misses by a little is snapped onto the nearest legal line rather than demoted —
 * see {@link SNAP_TOLERANCE}. When that happens the body records the line the model meant, so the
 * comment doesn't quietly point somewhere the author didn't expect.
 */
export function partitionFindings(
  findings: ReviewFinding[],
  diff: string | undefined,
): { inline: ReviewComment[]; outOfDiff: ReviewComment[]; snapped: number } {
  const rendered = findings.map((f) => ({ finding: f, comment: { path: f.path, line: f.line, body: renderFinding(f) } }));
  if (!diff) return { inline: rendered.map((r) => r.comment), outOfDiff: [], snapped: 0 };

  const lines = commentableLines(diff);
  const inline: ReviewComment[] = [];
  const outOfDiff: ReviewComment[] = [];
  let snapped = 0;

  for (const { finding, comment } of rendered) {
    const target = snapToCommentableLine(lines, finding.path, finding.line, SNAP_TOLERANCE);
    if (target === undefined) {
      outOfDiff.push(comment);
      continue;
    }
    if (target !== finding.line) {
      snapped++;
      inline.push({ ...comment, line: target, body: `${comment.body}\n\n_(Refers to line ${finding.line}.)_` });
      continue;
    }
    inline.push(comment);
  }
  return { inline, outOfDiff, snapped };
}

/**
 * Semantic problems worth spending a repair turn on, described for the model.
 *
 * Deliberately narrow: only mistakes the model can actually fix with one more look, and only when
 * fixing them changes what gets posted. A finding that merely scores below the confidence floor is
 * not listed — that is a judgement the gates handle silently, and telling the model would just
 * invite it to inflate the number.
 */
function describeProblems(data: ReviewOutput, ctx: ValidateContext): string[] {
  const problems: string[] = [];

  const changed = new Set(ctx.changedPaths);
  if (changed.size > 0) {
    const unknown = [...new Set(data.findings.filter((f) => !changed.has(f.path)).map((f) => f.path))];
    if (unknown.length > 0) {
      problems.push(
        `These finding paths are not among the files this pull request changes: ${unknown.map((p) => `\`${p}\``).join(', ')}. Either correct the path, or drop the finding if it is about unchanged code (out of scope).`,
      );
    }
  }

  if (ctx.anchorable.size > 0) {
    const stranded = data.findings.filter(
      (f) =>
        (changed.size === 0 || changed.has(f.path)) &&
        snapToCommentableLine(ctx.anchorable, f.path, f.line, SNAP_TOLERANCE) === undefined,
    );
    if (stranded.length > 0) {
      const detail = stranded
        .map((f) => {
          const ranges = ctx.anchorable.get(f.path);
          const legal = ranges ? [...ranges].sort((a, b) => a - b).join(', ') : 'none';
          return `  - \`${f.path}:${f.line}\` ("${f.shortSummary}") — anchorable lines in that file: ${legal}`;
        })
        .join('\n');
      problems.push(
        `These findings cannot be posted inline because their line is not in a changed hunk, and they are too far away to re-anchor automatically. Move each onto one of the listed lines (and say in the body which line you actually mean), or drop it:\n${detail}`,
      );
    }
  }

  const unsubstantiated = data.findings.filter((f) => !f.failureScenario.trim());
  if (unsubstantiated.length > 0) {
    problems.push(
      `These findings have an empty \`failureScenario\`: ${unsubstantiated.map((f) => `"${f.shortSummary}"`).join(', ')}. Give concrete inputs or state and the concrete wrong result, or drop the finding.`,
    );
  }

  return problems;
}

/** Auto-review mode: analyze the PR diff and post a review with inline findings. */
export const reviewMode: ModeDefinition<ReviewOutput> = {
  name: 'review',
  description:
    'Review the pull request diff and post inline findings with a verdict. Choose this when the user asks to review, re-review, take another look at, or give feedback on the pull request or its changes.',
  outputSchema: ReviewOutputSchema,
  tools: ['comment', 'review'],
  validate(data, ctx) {
    const problems = describeProblems(data, ctx);
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      repairPrompt: [
        'Your review is almost ready, but some findings cannot be posted as they stand. Fix only what is listed here and return the full structured answer again — keep every finding that is not mentioned exactly as it was, and do not go looking for new problems.',
        '',
        ...problems.map((p, i) => `${i + 1}. ${p}`),
        '',
        'Dropping a finding you cannot substantiate is a valid fix, and a better outcome than a finding a human cannot act on.',
      ].join('\n'),
    };
  },
  async finalize(ctx) {
    const number = subjectNumber(ctx.context, ctx.event);
    if (number === undefined) {
      return { summary: ctx.data.summary };
    }

    // Gate before anything else: a finding that fails the confidence or evidence bar should not
    // reach the forge, influence the verdict, or appear in a count.
    const { kept, dropped } = applyFindingGates(ctx.data.findings, {
      cwd: ctx.cwd,
      minConfidence: ctx.config.review.minConfidence,
      maxFindings: ctx.config.review.maxFindings,
      verifyQuotes: ctx.workspace?.containsPrHead !== false,
    });

    // Anchor only findings that land inside a changed hunk; the rest are folded into the review
    // body as text so a single out-of-diff line can't 422 the whole review (and lose it).
    const { inline, outOfDiff } = partitionFindings(kept, ctx.context.diff);
    const note = droppedNote(dropped);
    const body = foldCommentsIntoBody(note ? `${ctx.data.summary}\n\n${note}` : ctx.data.summary, outOfDiff);

    // Don't approve a change while telling the author it's broken. The prompt says the same thing,
    // but a verdict that contradicts the findings is confusing enough to be worth enforcing.
    const blocking = kept.some((f) => f.severity === 'blocker' || f.severity === 'major');
    const verdict = ctx.data.verdict === 'APPROVE' && blocking ? 'REQUEST_CHANGES' : ctx.data.verdict;

    // `comment_only` keeps crab'd from formally approving/blocking a PR: post a plain
    // COMMENT review regardless of verdict. The verdict still shows in the summary.
    const event = ctx.config.review.commentOnly ? 'COMMENT' : verdict;
    await ctx.adapter.postReview(number, {
      body,
      event, // GitHub/Forgejo require a raw APPROVE/COMMENT/REQUEST_CHANGES value
      comments: inline,
    });

    const count = inline.length;
    const suffix = count === 0 ? '' : ` (${count} inline finding${count === 1 ? '' : 's'})`;
    const verdictLine = `**${VERDICT_LABEL[verdict]}.**${suffix}`;
    // Prefix with the configured brand emoji (empty → no emoji), matching the comment leads.
    const emoji = ctx.config.appearance.emoji ? `${ctx.config.appearance.emoji} ` : '';
    return {
      summary: `${body}\n\n${verdictLine}`,
      // The full summary is in the posted review; keep the tracking comment short so it
      // isn't duplicated. See finalizeRun.
      trackingComment: `${emoji}Reviewed this pull request — ${verdictLine}`,
    };
  },
};

import * as v from 'valibot';
import type { ReviewFinding } from '../modes/review.ts';
import { splitSections } from './diff-parse.ts';

/**
 * The refuter's answer.
 *
 * `REFUTED` is a success, not a failure, and the prompt says so — a verifier that feels it should
 * be confirming things is just a second reviewer agreeing with the first. `UNCERTAIN` exists so the
 * refuter is never forced to guess: it keeps the finding out of the inline set without claiming the
 * finding is wrong.
 */
export const RefuterVerdictSchema = v.object({
  verdict: v.picklist(['CONFIRMED', 'REFUTED', 'UNCERTAIN']),
  /** How sure the refuter is of its own verdict, 1–10. */
  confidence: v.pipe(v.number(), v.minValue(1), v.maxValue(10)),
  /** One or two sentences. For REFUTED, the code or reason that makes the claim wrong. */
  reason: v.string(),
  /** A better line to anchor to, if the claim holds but the line is off. */
  correctedLine: v.optional(v.number()),
});

export type RefuterVerdict = v.InferOutput<typeof RefuterVerdictSchema>;

/** Standing instructions for a refuter session (the profile's system prompt). */
export const REFUTER_INSTRUCTIONS = [
  'You are a code-review verifier. A reviewer has claimed a specific pull request change is defective. Your job is to try to REFUTE that claim.',
  '',
  'Refuting a claim is a success. You are not here to agree — you are the check that stops a wrong finding being posted on a human\'s pull request. A reviewer\'s claim that survives you is worth posting; one that does not would have wasted the author\'s time and eroded their trust in every future review.',
  '',
  'You have not been told what the reviewer concluded overall, and you should not try to infer it. Judge this one claim on its own.',
  '',
  'How to decide:',
  '- Open the file and read the real code around the cited line. The claim may describe code that does not exist.',
  '- Look for what would prevent the problem: a guard, a type, validation in a caller, recovery downstream, a framework guarantee. Grep for the callers. If you find something that prevents it, quote it and return REFUTED.',
  '- Otherwise, try to construct the concrete input or state that triggers the claimed failure. If you can, return CONFIRMED and say what it is.',
  '- If the code is deliberate — a comment, the project instructions, or an obvious convention says so — return REFUTED.',
  '- If you genuinely cannot tell after looking, return UNCERTAIN. Do not guess in either direction.',
  '',
  'Do not review anything else. Do not report other problems you notice. Do not modify any file.',
].join('\n');

/** The diff hunk for one file, or `undefined` when the diff doesn't cover it. */
function hunkFor(diff: string | undefined, path: string): string | undefined {
  if (!diff) return undefined;
  return splitSections(diff).find((s) => s.path === path)?.text;
}

/** Per-finding char cap on the hunk handed to a refuter — it needs the change, not the whole file. */
const HUNK_BUDGET = 4_000;

/**
 * Build the prompt for one refuter.
 *
 * Prompt quality is what makes this stage worth its cost: a refuter told "check if this finding is
 * valid" returns a coin flip. So this hands over the claim verbatim, *only* the relevant hunk, the
 * question rather than the steps, and what is at stake — and deliberately withholds the reviewer's
 * summary and verdict so the refuter cannot simply defer to them.
 */
export function buildRefuterPrompt(
  finding: ReviewFinding,
  options: { repoSlug: string; diff?: string },
): string {
  const hunk = hunkFor(options.diff, finding.path);
  const parts: string[] = [
    `Repository: ${options.repoSlug}`,
    '',
    '## The claim to refute',
    `- Location: \`${finding.path}:${finding.line}\``,
    `- Severity claimed: ${finding.severity} (${finding.category})`,
    `- Claim: ${finding.shortSummary}`,
    '',
    finding.body,
    '',
    `**Claimed failure:** ${finding.failureScenario}`,
  ];

  if (finding.evidence.quote.trim()) {
    parts.push('', `**Cited as evidence** (\`${finding.evidence.location}\`):`, '```', finding.evidence.quote, '```');
  }

  if (hunk) {
    parts.push('', "## The change at that location", '```diff', hunk.slice(0, HUNK_BUDGET), '```');
  }

  parts.push(
    '',
    '## Your task',
    'Is this claim true? Read the actual code at that location with your file tools. Either find the code that already prevents this and quote it, or construct the concrete input or state that triggers it.',
    'Your verdict decides whether this is posted as an inline comment on a human\'s pull request.',
    'Answer in under 150 words.',
  );

  return parts.join('\n');
}

/**
 * Whether a finding survives its refuter.
 *
 * A missing verdict (the refuter failed, timed out, or returned nothing) keeps the finding: the
 * verify pass is there to remove false positives, not to silently swallow the review when the extra
 * model call goes wrong.
 */
export function survivesRefutation(
  verdict: RefuterVerdict | undefined,
  minConfidence: number,
): boolean {
  if (!verdict) return true;
  if (verdict.verdict === 'REFUTED') return false;
  if (verdict.verdict === 'UNCERTAIN') return false;
  return verdict.confidence >= minConfidence;
}

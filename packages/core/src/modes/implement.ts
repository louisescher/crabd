import * as v from 'valibot';
import { collectChangesSinceBaseline } from '../git/changes.ts';
import { BranchMovedError } from '../forge/commit-guard.ts';
import { brandPrBody, forceBranchPrefix, implementPhase } from '../forge/ownership.ts';
import type { ReviewThreadSummary } from '../forge/types.ts';
import { REPLY_MARKER } from '../report/tracking.ts';
import type { FinalizeContext, ModeDefinition, ValidateContext, ValidateResult } from './registry.ts';
import { commitWorkingChanges, subjectNumber } from './shared.ts';

export const THREAD_OUTCOMES = ['fixed', 'already-fixed', 'partial', 'declined', 'answered', 'unclear'] as const;

export type ThreadOutcome = (typeof THREAD_OUTCOMES)[number];

/** Outcomes that mean the code now satisfies the thread, and so may resolve it. */
const RESOLVING_OUTCOMES = new Set<ThreadOutcome>(['fixed', 'already-fixed']);

export const ThreadResponseSchema = v.object({
  thread_id: v.string(),
  outcome: v.picklist(THREAD_OUTCOMES),
  reply: v.pipe(v.string(), v.maxLength(4_000)),
});

export const VerificationRunSchema = v.object({
  command: v.string(),
  status: v.picklist(['passed', 'failed', 'not-run']),
  detail: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
});

export type VerificationRun = v.InferOutput<typeof VerificationRunSchema>;

/**
 * One schema for both phases, with a discriminator rather than a `v.variant`: the schema becomes
 * the `submit` tool's JSON schema, and a variant renders as a root-level `oneOf`, which strict
 * function-calling providers reject. `validate` enforces what the shape cannot.
 */
export const ImplementOutputSchema = v.object({
  kind: v.picklist(['issue', 'round']),
  summary: v.string(),
  pr_title: v.optional(v.string()),
  branch: v.optional(v.string()),
  pr_body: v.optional(v.string()),
  commit_message: v.optional(v.string()),
  threads: v.optional(v.array(ThreadResponseSchema)),
  verification: v.optional(v.array(VerificationRunSchema)),
  no_changes_reason: v.optional(v.string()),
});

export type ImplementOutput = v.InferOutput<typeof ImplementOutputSchema>;

function describeProblems(data: ImplementOutput, ctx: ValidateContext): string[] {
  const problems: string[] = [];
  const expected = ctx.subjectKind === 'pull_request' ? 'round' : 'issue';
  if (ctx.subjectKind && data.kind !== expected) {
    problems.push(
      expected === 'round'
        ? `You answered with \`kind: "issue"\`, but this run is a feedback round on an open pull request. Answer with \`kind: "round"\`, a \`commit_message\`, and one \`threads\` entry per open thread.`
        : `You answered with \`kind: "round"\`, but this run implements an issue and has no pull request yet. Answer with \`kind: "issue"\`, a \`pr_title\`, \`pr_body\` and \`branch\`.`,
    );
  }

  if (data.kind === 'issue') {
    if (!data.pr_title?.trim()) problems.push('`pr_title` is required when opening a pull request.');
    if (!data.pr_body?.trim()) problems.push('`pr_body` is required when opening a pull request.');
    if (!data.branch?.trim()) problems.push('`branch` is required when opening a pull request.');
  }

  if (data.kind === 'round') {
    if (!data.commit_message?.trim()) {
      problems.push('`commit_message` is required on a round: it is the subject of the commit that lands on the pull request.');
    }
    const legal = new Set(ctx.threadIds ?? []);
    const seen = new Set<string>();
    for (const thread of data.threads ?? []) {
      if (legal.size > 0 && !legal.has(thread.thread_id)) {
        problems.push(
          `\`${thread.thread_id}\` is not one of the open threads. Copy an id exactly as it appears in the feedback list: ${[...legal].join(', ')}.`,
        );
      }
      if (seen.has(thread.thread_id)) problems.push(`\`${thread.thread_id}\` appears twice. Answer each thread once.`);
      seen.add(thread.thread_id);
      if (!thread.reply.trim()) problems.push(`\`${thread.thread_id}\` has an empty reply. Say what you did, or why you did not.`);
    }
    const missing = [...legal].filter((id) => !seen.has(id));
    if (missing.length > 0) {
      problems.push(
        `These threads have no entry: ${missing.join(', ')}. Every open thread needs one, even if the answer is that you are declining it.`,
      );
    }
  }

  const required = ctx.verifyCommands ?? [];
  if (required.length > 0) {
    const reported = new Set((data.verification ?? []).map((run) => run.command.trim()));
    const unreported = required.filter((command) => !reported.has(command.trim()));
    if (unreported.length > 0) {
      problems.push(
        `Run these and report each one in \`verification\`: ${unreported.map((c) => `\`${c}\``).join(', ')}.`,
      );
    }
  }

  return problems;
}

function renderVerification(runs: VerificationRun[] | undefined): string {
  if (!runs || runs.length === 0) return '';
  const rows = runs.map((run) => {
    const icon = run.status === 'passed' ? '✅' : run.status === 'failed' ? '❌' : '⏭️';
    const detail = run.status === 'passed' || !run.detail?.trim() ? '' : `\n  <details><summary>output</summary>\n\n\`\`\`\n${run.detail.trim()}\n\`\`\`\n\n  </details>`;
    return `- ${icon} \`${run.command}\`${detail}`;
  });
  const failed = runs.some((run) => run.status !== 'passed');
  const lead = failed
    ? '**Verification** (a failure here does not block the commit, the checks on this pull request decide that):'
    : '**Verification**:';
  return `\n\n${lead}\n${rows.join('\n')}`;
}

const OUTCOME_LABEL: Record<ThreadOutcome, string> = {
  fixed: 'fixed',
  'already-fixed': 'already fixed',
  partial: 'partly done',
  declined: 'declined',
  answered: 'answered',
  unclear: 'needs clarification',
};

function anchorOf(thread: ReviewThreadSummary): string {
  return thread.line === undefined ? `\`${thread.path}\`` : `\`${thread.path}:${thread.line}\``;
}

function renderThreadSummary(
  entries: { thread: ReviewThreadSummary; outcome: ThreadOutcome; reply: string }[],
  resolvable: boolean,
): string {
  if (entries.length === 0) return '';
  const rows = entries.map(
    ({ thread, outcome, reply }) => `- ${anchorOf(thread)}: **${OUTCOME_LABEL[outcome]}**\n\n  ${reply.trim().replace(/\n/g, '\n  ')}`,
  );
  const note = resolvable
    ? ''
    : '\n\nThis forge has no API for resolving a review conversation, so the ones marked fixed are left for you to resolve.';
  return `\n\n**Review feedback**\n\n${rows.join('\n\n')}${note}`;
}

async function finalizeIssue(ctx: FinalizeContext<ImplementOutput>): Promise<{
  summary: string;
  prUrl?: string;
}> {
  const prefix = ctx.config.implement.branchPrefix;
  const fallback = `${prefix}implement-${subjectNumber(ctx.context, ctx.event) ?? 'issue'}`;
  const branch = forceBranchPrefix(ctx.data.branch?.trim() || fallback, prefix);
  const verification = renderVerification(ctx.data.verification);
  const committed = await commitWorkingChanges({
    adapter: ctx.adapter,
    cwd: ctx.cwd,
    branch,
    message: ctx.data.pr_title ?? ctx.data.summary,
    baseBranch: ctx.context.repo.defaultBranch,
    writesAllowed: ctx.config.permissions.write,
    baseline: ctx.baseline,
    secretScan: ctx.config.permissions.secretScan,
  });

  if (!committed) {
    const reason = ctx.data.no_changes_reason?.trim();
    return {
      summary: `${ctx.data.summary}${verification}\n\n⚠️ No file changes were produced, so no pull request was opened.${reason ? ` ${reason}` : ''}`,
    };
  }

  const pr = await ctx.adapter.openOrUpdatePR({
    title: ctx.data.pr_title ?? ctx.data.summary,
    body: brandPrBody(`${ctx.data.pr_body ?? ctx.data.summary}${verification}`),
    headBranch: branch,
    baseBranch: ctx.context.repo.defaultBranch,
  });
  return { summary: `${ctx.data.summary}${verification}`, prUrl: pr.url };
}

/** The patch a round would have committed, for the cases where it may not commit at all. */
function renderIntendedChange(ctx: FinalizeContext<ImplementOutput>): string {
  const changes = collectChangesSinceBaseline(ctx.cwd, ctx.baseline);
  if (changes.length === 0) return '';
  const paths = changes.map((change) => `- \`${change.path}\` (${change.op === 'delete' ? 'deleted' : 'changed'})`);
  return `\n\nThe change I had made, and did not commit:\n${paths.join('\n')}`;
}

async function finalizeRound(ctx: FinalizeContext<ImplementOutput>): Promise<{
  summary: string;
  trackingComment?: string;
  handledThreadReplies?: boolean;
}> {
  const pr = ctx.context.pullRequest;
  const verification = renderVerification(ctx.data.verification);
  if (!pr) return { summary: `${ctx.data.summary}${verification}` };

  const threads = ctx.context.reviewThreads ?? [];
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const answered = (ctx.data.threads ?? [])
    .map((entry) => {
      const thread = byId.get(entry.thread_id);
      return thread ? { thread, outcome: entry.outcome, reply: entry.reply } : undefined;
    })
    .filter((entry): entry is { thread: ReviewThreadSummary; outcome: ThreadOutcome; reply: string } => Boolean(entry));

  const canReplyInThread = ctx.adapter.kind === 'github';
  const refuse = (reason: string): { summary: string; trackingComment: string } => {
    const body = `${ctx.data.summary}${renderThreadSummary(answered, false)}${verification}\n\n⚠️ ${reason}${renderIntendedChange(ctx)}`;
    return { summary: body, trackingComment: body };
  };

  if (pr.fromFork) {
    return refuse(
      `This pull request's branch lives in \`${pr.headRepoSlug ?? 'another repository'}\`, so I cannot commit to it. Pull the change yourself, or push the branch to this repository.`,
    );
  }
  if (!pr.headRef) return refuse('This pull request reports no head branch, so there is nothing I can commit to.');
  if (!pr.headSha) {
    return refuse(
      'This pull request reports no head commit, so I cannot check that the branch is still where I read it and will not commit blind.',
    );
  }
  if (ctx.workspace?.containsPrHead === false) {
    return refuse(
      "The checkout is not this pull request's head commit, so committing from it would revert whatever the branch has that the checkout does not.",
    );
  }

  let committed = false;
  try {
    committed = await commitWorkingChanges({
      adapter: ctx.adapter,
      cwd: ctx.cwd,
      branch: pr.headRef,
      message: ctx.data.commit_message ?? ctx.data.summary,
      baseBranch: pr.baseRef || ctx.context.repo.defaultBranch,
      expectedParentSha: pr.headSha,
      writesAllowed: ctx.config.permissions.write,
      baseline: ctx.baseline,
      secretScan: ctx.config.permissions.secretScan,
    });
  } catch (error) {
    if (!(error instanceof BranchMovedError)) throw error;
    return refuse(`${error.message} Ask again and I will work from the new head.`);
  }

  const resolveThreads = ctx.config.implement.rounds.resolveThreads;
  let resolved = 0;
  let resolutionUnsupported = false;
  const failures: string[] = [];

  if (canReplyInThread) {
    for (const entry of answered) {
      try {
        await ctx.adapter.replyToReviewComment(
          pr.number,
          entry.thread.rootCommentId,
          `${entry.reply.trim()}\n\n${REPLY_MARKER}`,
        );
      } catch (error) {
        failures.push(`could not reply on ${anchorOf(entry.thread)}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const resolvable = entry.outcome === 'already-fixed' || (entry.outcome === 'fixed' && committed);
      if (!resolveThreads || !resolvable) continue;
      try {
        const done = await ctx.adapter.resolveReviewThread(entry.thread.id);
        if (done) resolved += 1;
        else resolutionUnsupported = true;
      } catch (error) {
        failures.push(`could not resolve ${anchorOf(entry.thread)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else {
    resolutionUnsupported = true;
  }

  const notes: string[] = [];
  if (!committed) {
    const reason = ctx.data.no_changes_reason?.trim();
    notes.push(`ℹ️ No file changes were produced, so nothing was committed.${reason ? ` ${reason}` : ''}`);
  }
  if (failures.length > 0) notes.push(`⚠️ ${failures.join('; ')}.`);

  const inThreadReplies = canReplyInThread && answered.length > 0;
  const noteBlock = notes.length > 0 ? `\n\n${notes.join('\n\n')}` : '';
  const summaryBody = [
    ctx.data.summary,
    inThreadReplies ? '' : renderThreadSummary(answered, !resolutionUnsupported),
    verification,
    noteBlock,
  ].join('');

  const counts = [
    `${answered.length} conversation${answered.length === 1 ? '' : 's'} answered`,
    ...(resolved > 0 ? [`${resolved} resolved`] : []),
  ].join(', ');
  const lead = committed ? `Pushed a commit to \`${pr.headRef}\`: ${counts}.` : `${counts}, nothing to commit.`;

  // When the replies went into the conversations themselves, the tracking comment stays short.
  // When they did not, it is the only place they appear, so it carries the whole answer.
  const trackingComment = inThreadReplies
    ? `${lead}${verification}${noteBlock}`
    : `${lead}${renderThreadSummary(answered, !resolutionUnsupported)}${verification}${noteBlock}`;

  return {
    summary: summaryBody,
    trackingComment,
    // Always set on a round: the thread answers are posted by this mode, so the generic inline
    // reply in `finalizeRun` would either duplicate them or post an unmarked comment that a later
    // event could mistake for a human's.
    handledThreadReplies: true,
  };
}

/**
 * Implement mode: build the change and open a pull request for an issue, or answer the open
 * feedback on a pull request and commit onto its branch.
 */
export const implementMode: ModeDefinition<ImplementOutput> = {
  name: 'implement',
  description:
    "Implement a requested change end-to-end, and address review feedback on a pull request crab'd already opened. Choose this when the user asks crab'd to build, add, fix, refactor, or otherwise change the code itself, or to act on a review.",
  outputSchema: ImplementOutputSchema,
  tools: ['comment', 'commit', 'open_pr', 'review'],
  // Committing and opening the pull request *is* this mode; there is no read-only version of it,
  // so `prepareRun` gates it out entirely rather than letting it run and produce nothing.
  writes: 'required',
  validate(data, ctx): ValidateResult {
    const problems = describeProblems(data, ctx);
    if (problems.length === 0) return { ok: true };
    return {
      ok: false,
      repairPrompt: [
        'Your answer needs correcting before it can be applied:',
        ...problems.map((problem) => `- ${problem}`),
        '',
        'Submit the whole answer again with those points fixed. Keep everything else exactly as it was, and do not go looking for new work.',
      ].join('\n'),
    };
  },
  async finalize(ctx) {
    const phase = implementPhase(ctx.context, ctx.event);
    return phase === 'round' ? finalizeRound(ctx) : finalizeIssue(ctx);
  },
};

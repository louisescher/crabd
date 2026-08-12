import { existsSync, readFileSync } from 'node:fs';
import { init, type JsonValue } from '@flue/runtime';
import * as v from 'valibot';
import {
  buildRefuterPrompt,
  RefuterVerdictSchema,
  survivesRefutation,
  type RefuterVerdict,
  type ReviewFinding,
  type ReviewOutput,
} from '@crabd/core';
import { CrabdRefuter, type RefuterCreation } from './agents/crabd-refuter.ts';
import { runContext } from './run-context.ts';
import type { ThinkingLevel } from '@crabd/config';

/** The pull request diff, read from the temp file the CLI wrote. */
function readDiff(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

/** Run `worker` over `items` with at most `limit` in flight. Preserves input order in the result. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface VerifyInput {
  data: JsonValue;
  mode: string;
  model: string;
  partial: boolean;
  thinking?: ThinkingLevel;
  onProgress?: (summary: string) => void;
}

/**
 * The opt-in second pass: send each candidate finding to an independent, blinded refuter and keep
 * only what survives.
 *
 * Every refuter is its own agent instance, so it sees the claim and the code but *not* the reviewer's
 * conversation — which is the whole point, since a verifier that can read the argument tends to agree
 * with it. In flue 1 this was a `session.task(..., { agent: 'refuter' })` child session; v2 delegation
 * is model-driven through the `task` tool, so the fan-out is addressed rather than delegated, which
 * keeps it deterministic: one instance per finding, concurrency ours to choose.
 *
 * Entirely best-effort and additive: any failure keeps the original findings, because losing a real
 * review to a flaky extra call is the worse outcome.
 *
 * Returns `undefined` when the stage didn't run, so the caller can tell "not run" from "ran and
 * confirmed everything".
 */
export async function verifyFindings(
  input: VerifyInput,
): Promise<{ data: JsonValue; confirmed: number; refuted: number } | undefined> {
  const ctx = runContext();
  const cfg = ctx.verify;
  if (!cfg.enabled || input.mode !== 'review') return undefined;
  // A partial answer already ran out of budget; spending more on verification would just make the
  // timeout worse.
  if (input.partial) return undefined;

  const output = input.data as ReviewOutput | null;
  const findings = output?.findings;
  if (!Array.isArray(findings) || findings.length === 0) return undefined;

  const diff = readDiff(ctx.diffPath);
  const repoSlug = ctx.repoSlug ?? 'this repository';
  const verifyModel = cfg.model ?? input.model;
  const runId = ctx.runId;

  const verdicts = await mapWithConcurrency(
    findings,
    cfg.maxConcurrency,
    async (finding: ReviewFinding, i = findings.indexOf(finding)): Promise<RefuterVerdict | undefined> => {
      try {
        const handle = init(CrabdRefuter, { id: `${runId}-refuter-${i}` });
        const creation: RefuterCreation = {
          model: verifyModel,
          ...(input.thinking ? { thinking: input.thinking } : {}),
        };
        const receipt = await handle.dispatch({
          message: buildRefuterPrompt(finding, { repoSlug, ...(diff ? { diff } : {}) }),
          initialData: creation,
        });
        const reply = await handle.read(receipt);
        const raw = reply.data?.verdict?.at(-1);
        return raw ? v.parse(RefuterVerdictSchema, raw) : undefined;
      } catch {
        // This finding simply goes unverified; see survivesRefutation.
        return undefined;
      }
    },
  );

  const kept: ReviewFinding[] = [];
  let refuted = 0;
  findings.forEach((finding, i) => {
    const verdict = verdicts[i];
    if (survivesRefutation(verdict, cfg.minConfidence)) {
      // A refuter that agreed but found a better line is worth listening to.
      const line = verdict?.correctedLine;
      kept.push(typeof line === 'number' && line > 0 ? { ...finding, line } : finding);
      return;
    }
    refuted++;
  });

  input.onProgress?.(`Verified ${kept.length} of ${findings.length} findings (${refuted} refuted).`);

  return { data: { ...output, findings: kept } as unknown as JsonValue, confirmed: kept.length, refuted };
}

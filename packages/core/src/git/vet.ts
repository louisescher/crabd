import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { FileChange } from '../forge/types.ts';

export interface SecretFinding {
  path: string;
  ruleId: string;
  line?: number;
  description?: string;
}

/**
 * Why gitleaks did not produce a verdict, distinct from `secrets_detected` (a verdict was
 * produced, and it found something).
 *
 * - `timeout`: gitleaks did not finish within the budget, even after one retry.
 * - `binary_missing`: gitleaks is not on `PATH` (`ENOENT` spawning it).
 * - `other`: anything else, including a report gitleaks wrote that could not be parsed.
 */
export type ScanUnavailableCause = 'timeout' | 'binary_missing' | 'other';

export type VetResult =
  | { ok: true }
  | { ok: false; reason: 'secrets_detected'; findings: SecretFinding[] }
  | {
      ok: false;
      reason: 'scan_unavailable';
      cause: ScanUnavailableCause;
      detail: string;
      timeoutMs?: number;
      fileCount?: number;
    };

interface GitleaksEntry {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Description?: string;
}

/**
 * Default timeout for one gitleaks invocation, in milliseconds.
 *
 * 30s was too tight for a large change set on a loaded runner: a busy box under memory pressure
 * blew through it on an otherwise-clean commit. 120s gives gitleaks room to scan a sizeable diff
 * even when the runner is under load, while still failing closed if it truly hangs.
 */
const DEFAULT_SCAN_TIMEOUT_MS = 120_000;

export function scanForSecrets(changes: FileChange[], options?: { binary?: string; timeoutMs?: number }): VetResult {
  const upserts = changes.filter((c) => c.op === 'upsert');
  if (upserts.length === 0) return { ok: true };

  const binary = options?.binary ?? 'gitleaks';
  const timeoutMs = options?.timeoutMs ?? DEFAULT_SCAN_TIMEOUT_MS;
  const scratch = mkdtempSync(join(tmpdir(), 'crabd-vet-'));
  const srcRoot = join(scratch, 'src');
  const reportPath = join(scratch, '.gitleaks-report.json');

  try {
    for (const change of upserts) {
      const target = join(srcRoot, change.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(change.contentBase64 ?? '', 'base64'));
    }

    const args = ['directory', srcRoot, '--report-format', 'json', '--report-path', reportPath, '--exit-code', '1', '--no-banner', '--redact'];

    let lastError: unknown;
    let timedOut = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        execFileSync(binary, args, { timeout: timeoutMs, stdio: ['ignore', 'ignore', 'pipe'] });
        return { ok: true };
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 1) {
          try {
            const raw = readFileSync(reportPath, 'utf-8');
            const entries = JSON.parse(raw) as GitleaksEntry[];
            const findings: SecretFinding[] = entries.map((entry) => ({
              path: relative(srcRoot, entry.File ?? ''),
              ruleId: entry.RuleID ?? 'unknown',
              ...(entry.StartLine !== undefined ? { line: entry.StartLine } : {}),
              ...(entry.Description ? { description: entry.Description } : {}),
            }));
            return { ok: false, reason: 'secrets_detected', findings };
          } catch (parseError) {
            const detail = parseError instanceof Error ? parseError.message : String(parseError);
            return {
              ok: false,
              reason: 'scan_unavailable',
              cause: 'other',
              detail: `gitleaks reported findings, but the report could not be read: ${detail}`,
            };
          }
        }

        lastError = error;
        if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          timedOut = true;
          continue;
        }
        break;
      }
    }

    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    if (timedOut) {
      return { ok: false, reason: 'scan_unavailable', cause: 'timeout', detail, timeoutMs, fileCount: upserts.length };
    }
    const cause: ScanUnavailableCause = (lastError as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'binary_missing' : 'other';
    return { ok: false, reason: 'scan_unavailable', cause, detail };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function renderVetFailureMessage(vet: Extract<VetResult, { ok: false }>): string {
  if (vet.reason === 'scan_unavailable') {
    if (vet.cause === 'timeout') {
      const files = vet.fileCount === 1 ? '1 file' : `${vet.fileCount} files`;
      return `the secret scanner did not finish scanning ${files} within ${vet.timeoutMs}ms, even after a retry. This is a fail-closed safety check, so the commit did not happen. If this persists, turn the scan off on purpose with \`permissions.secret_scan\` in the config reference.`;
    }
    if (vet.cause === 'binary_missing') {
      return `the secret scanner could not run because gitleaks is not on PATH (${vet.detail}). This is a crab'd packaging problem, so please report it.`;
    }
    return `the secret scanner could not run (${vet.detail}). This is a fail-closed safety check, so contact a maintainer if this persists.`;
  }
  const shown = vet.findings.slice(0, 10).map((f) => `\`${f.path}${f.line ? `:${f.line}` : ''}\` (${f.ruleId})`);
  const more = vet.findings.length > shown.length ? `, +${vet.findings.length - shown.length} more` : '';
  return `gitleaks found ${vet.findings.length} potential secret${vet.findings.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
}

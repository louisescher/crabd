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

export type VetResult =
  | { ok: true }
  | { ok: false; reason: 'secrets_detected'; findings: SecretFinding[] }
  | { ok: false; reason: 'scan_unavailable'; detail: string };

interface GitleaksEntry {
  RuleID?: string;
  File?: string;
  StartLine?: number;
  Description?: string;
}

export function scanForSecrets(changes: FileChange[], options?: { binary?: string; timeoutMs?: number }): VetResult {
  const upserts = changes.filter((c) => c.op === 'upsert');
  if (upserts.length === 0) return { ok: true };

  const binary = options?.binary ?? 'gitleaks';
  const scratch = mkdtempSync(join(tmpdir(), 'crabd-vet-'));
  const srcRoot = join(scratch, 'src');
  const reportPath = join(scratch, '.gitleaks-report.json');

  try {
    for (const change of upserts) {
      const target = join(srcRoot, change.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(change.contentBase64 ?? '', 'base64'));
    }

    try {
      execFileSync(
        binary,
        ['directory', srcRoot, '--report-format', 'json', '--report-path', reportPath, '--exit-code', '1', '--no-banner', '--redact'],
        { timeout: options?.timeoutMs ?? 30_000, stdio: ['ignore', 'ignore', 'pipe'] },
      );
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
          return { ok: false, reason: 'scan_unavailable', detail: `gitleaks reported findings, but the report could not be read: ${detail}` };
        }
      }
      const detail = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: 'scan_unavailable', detail };
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function renderVetFailureMessage(vet: Extract<VetResult, { ok: false }>): string {
  if (vet.reason === 'scan_unavailable') {
    return `the secret scanner could not run (${vet.detail}). This is a fail-closed safety check, so contact a maintainer if this persists.`;
  }
  const shown = vet.findings.slice(0, 10).map((f) => `\`${f.path}${f.line ? `:${f.line}` : ''}\` (${f.ruleId})`);
  const more = vet.findings.length > shown.length ? `, +${vet.findings.length - shown.length} more` : '';
  return `gitleaks found ${vet.findings.length} potential secret${vet.findings.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}`;
}

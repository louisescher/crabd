import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { FileChange } from '../forge/types.ts';
import { renderVetFailureMessage, scanForSecrets } from './vet.ts';

function detectGitleaks(): boolean {
  try {
    execFileSync('gitleaks', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const hasGitleaks = detectGitleaks();
if (!hasGitleaks) {
  // eslint-disable-next-line no-console
  console.warn('gitleaks not found on PATH, so packages/core/src/git/vet.test.ts skipped its real-scan cases.');
}

function upsert(path: string, content: string): FileChange {
  return { path, op: 'upsert', contentBase64: Buffer.from(content).toString('base64') };
}

describe('scanForSecrets', () => {
  it('returns ok for no changes', () => {
    expect(scanForSecrets([])).toEqual({ ok: true });
  });

  it('returns ok without invoking gitleaks for deletions only', () => {
    const result = scanForSecrets([{ path: 'gone.txt', op: 'delete' }], { binary: '/nonexistent/gitleaks' });
    expect(result).toEqual({ ok: true });
  });

  it('fails closed (scan_unavailable), never ok, when the binary is missing', () => {
    const result = scanForSecrets([upsert('a.txt', 'hello')], { binary: '/nonexistent/gitleaks' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('scan_unavailable');
  });

  it.runIf(hasGitleaks)('returns ok for clean content', () => {
    const result = scanForSecrets([upsert('README.md', '# hello\n\nnothing secret here.\n')]);
    expect(result).toEqual({ ok: true });
  });

  it.runIf(hasGitleaks)('detects an AWS access key and never exposes the secret value', () => {
    const secret = 'AKIAABCDEFGHIJKLMNOP';
    const result = scanForSecrets([upsert('config/.env', `AWS_ACCESS_KEY_ID=${secret}\n`)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('secrets_detected');
    if (result.reason !== 'secrets_detected') return;
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]).toEqual(
      expect.objectContaining({ path: 'config/.env', ruleId: expect.any(String) }),
    );
    for (const finding of result.findings) {
      expect(Object.keys(finding).sort()).toEqual(expect.arrayContaining(['path', 'ruleId']));
      expect(JSON.stringify(finding)).not.toContain(secret);
    }
    expect(renderVetFailureMessage(result)).not.toContain(secret);
  });

  it.runIf(hasGitleaks)('detects a GCP service-account private key, mirroring the incident shape', () => {
    const key = [
      '-----BEGIN PRIVATE KEY-----',
      'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDQY7lJz6nF9example',
      '-----END PRIVATE KEY-----',
    ].join('\\n');
    const creds = JSON.stringify({
      type: 'service_account',
      project_id: 'fake-project',
      private_key_id: 'abc123',
      private_key: key,
      client_email: 'fake@fake-project.iam.gserviceaccount.com',
    });
    const result = scanForSecrets([upsert('gha-creds-abc123.json', creds)]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('secrets_detected');
    if (result.reason !== 'secrets_detected') return;
    for (const finding of result.findings) {
      expect(JSON.stringify(finding)).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDQY7lJz6nF9example');
    }
  });
});

describe('renderVetFailureMessage', () => {
  it('renders a scan_unavailable reason without exposing internals oddly', () => {
    const message = renderVetFailureMessage({ ok: false, reason: 'scan_unavailable', detail: 'ENOENT' });
    expect(message).toContain('could not run');
    expect(message).toContain('ENOENT');
  });

  it('caps the listed findings and notes how many more there are', () => {
    const findings = Array.from({ length: 15 }, (_, i) => ({ path: `f${i}.txt`, ruleId: 'generic-api-key' }));
    const message = renderVetFailureMessage({ ok: false, reason: 'secrets_detected', findings });
    expect(message).toContain('15 potential secrets');
    expect(message).toContain('+5 more');
  });
});

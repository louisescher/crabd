import { describe, expect, it } from 'vitest';
import { isGeneratedCredentialFile, looksLikeCredential } from './sensitive.ts';

describe('isGeneratedCredentialFile', () => {
  it.each([
    'gha-creds-07aacde2c992b73b.json',
    'gha-creds-abc123.JSON',
    'nested/gha-creds-deadbeef.json',
    '.aws/credentials',
    'application_default_credentials.json',
  ])('catches %s', (path) => {
    expect(isGeneratedCredentialFile(path)).toBe(true);
  });

  it.each(['src/gha-creds.ts', 'docs/gha-creds-setup.md', 'creds.json', 'packages/app/credentials.md'])(
    'leaves %s alone',
    (path) => {
      expect(isGeneratedCredentialFile(path)).toBe(false);
    },
  );
});

describe('looksLikeCredential', () => {
  it.each([
    '.env',
    '.env.local',
    '.env.production',
    'apps/web/.env',
    '.npmrc',
    '.netrc',
    '.pgpass',
    '.ssh/id_rsa',
    'id_ed25519',
    'id_rsa.pub',
    'certs/server.pem',
    'private.key',
    'store.p12',
    'bundle.pfx',
    'release.jks',
    'app.keystore',
    'deploy.ppk',
    'secrets.kdbx',
    'service-account.json',
    'config/service_account-prod.json',
    'serviceaccount.json',
    'credentials.json',
    'client-secret-123.json',
    'kubeconfig',
    '.docker/config.json',
  ])('catches %s', (path) => {
    expect(looksLikeCredential(path)).toBe(true);
  });

  // A repository commits these on purpose, and a tracked path never reaches this check anyway.
  it.each([
    '.env.example',
    '.env.sample',
    '.env.template',
    'config.pem.example',
    'src/index.ts',
    'package.json',
    'README.md',
    'packages/core/src/git/sensitive.ts',
    'test/fixtures/keys.ts',
    'docs/environment.md',
  ])('leaves %s alone', (path) => {
    expect(looksLikeCredential(path)).toBe(false);
  });
});

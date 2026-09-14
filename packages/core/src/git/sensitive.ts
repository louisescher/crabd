/**
 * Paths a commit must never carry, checked on the path alone.
 *
 * This runs before and independently of the gitleaks scan, because every layer that should have
 * caught the real case was off or bypassed. A run on a repository with `permissions.secret_scan`
 * disabled ran a repo-wide `prettier --write`, which reformatted the `gha-creds-*.json` that
 * `google-github-actions/auth` writes into `GITHUB_WORKSPACE`. Reformatting changed the file's
 * hash, so the baseline no longer recognised it as pre-existing, and it went into the commit.
 *
 * A path check holds where content scanning does not: it needs no scanner binary, no time budget
 * and no config opt-in, and it still fires when the credential is a short-lived federation config
 * that no secret regex matches.
 */

/** Generated into the checkout by a workflow step, never part of anyone's change. */
const GENERATED_CREDENTIAL_FILES: RegExp[] = [
  // google-github-actions/auth, which writes its ADC file into GITHUB_WORKSPACE by default.
  /(^|\/)gha-creds-[0-9a-f]+\.json$/i,
  // aws-actions/configure-aws-credentials and the gcloud CLI, when pointed at the workspace.
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)application_default_credentials\.json$/i,
];

/**
 * Shapes that are a credential wherever they appear. Matched only against paths git reports as
 * untracked, so a repository's own committed test fixture (`test/fixtures/key.pem`, an `.env.example`
 * the repo tracks) is never caught by this: it is tracked, and a run editing it is doing normal work.
 */
const CREDENTIAL_SHAPES: RegExp[] = [
  /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)_netrc$/i,
  /(^|\/)\.pgpass$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg|kdbx)$/i,
  /(^|\/)(service[-_]?account|serviceaccount|credentials|client[-_]secret)[^/]*\.json$/i,
  /(^|\/)kubeconfig$/i,
  /(^|\/)\.docker\/config\.json$/i,
];

/** An `.env.example` is documentation, and repositories commit them on purpose. */
const CREDENTIAL_SHAPE_EXEMPTIONS: RegExp[] = [
  /\.(example|sample|template|dist|tpl)$/i,
  /(^|\/)\.env\.(example|sample|template|defaults|schema)$/i,
];

/** A path a workflow step generated, which is dropped from the commit rather than failing it. */
export function isGeneratedCredentialFile(path: string): boolean {
  return GENERATED_CREDENTIAL_FILES.some((re) => re.test(path));
}

/**
 * Whether an untracked path looks like a credential. Tracked paths are never passed here: a
 * repository that already commits a file has made that call, and a run editing it is doing its job.
 */
export function looksLikeCredential(path: string): boolean {
  if (CREDENTIAL_SHAPE_EXEMPTIONS.some((re) => re.test(path))) return false;
  return CREDENTIAL_SHAPES.some((re) => re.test(path));
}

/** Raised when a commit would carry an untracked path that looks like a credential. */
export class SensitivePathError extends Error {
  constructor(readonly paths: string[]) {
    super(`crabd: refusing to commit ${paths.length} path(s) that look like credentials`);
    this.name = 'SensitivePathError';
  }
}

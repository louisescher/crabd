---
'@crabd/core': minor
---

Refuses a commit that carries an untracked path shaped like a credential, and drops the credential files a workflow step generates in the checkout. Checked on the path alone, before the gitleaks scan and independently of `permissions.secret_scan`, because every content-based layer can be off, absent, or bypassed. `gha-creds-*.json`, `.aws/credentials` and `application_default_credentials.json` are dropped from the commit and logged. Any other untracked `.env`, `*.pem`, `*.key`, `id_rsa`, `service-account*.json`, `kubeconfig` and similar refuses the whole commit, naming the path. Tracked paths are never checked, so a repository's own committed test fixture stays editable, and `.example` / `.sample` / `.template` suffixes are exempt.

This closes a path that ran end to end. A repository with the secret scan disabled ran a repo-wide `prettier --write`, which reformatted the ADC file `google-github-actions/auth` writes into `GITHUB_WORKSPACE`. Reformatting changed the file's hash, the baseline stopped recognising it as pre-existing, and it went into the commit.

Skips untracked directory entries when collecting changes. `git status` reports one as a single path ending in `/`, and handing that to a file read raised `EISDIR` and failed the commit with an error naming nothing actionable.

Tells the agent that untracked build output is skipped for it. A run that saw `?? .pnpm-store/` in `git status --short` edited `.gitignore` to hide it, and that edit landed in the commit. The contract now says to leave it alone, and names the repo-wide formatter commands (`pnpm format`, `prettier --write .`, `eslint --fix .`) rather than only the category, because a run read the category and ran `pnpm format` anyway.

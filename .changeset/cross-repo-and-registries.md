---
"@crabd/config": minor
"@crabd/core": minor
"@crabd/action": minor
---

Config-driven cross-repo read access and private npm registries — no workflow changes.

- **`repos.read`** (`'all'` or a list of `owner/repo`, globs allowed) lets the agent **read** other
  repositories. crab'd mints a **read-only, least-privilege** forge token scoped to what you allow and
  exposes it to the model's shell as `GH_TOKEN` (with `git` preconfigured), so it can `gh api` / `git
  clone` those repos on demand — never write to them. Requires your own App (`CRABD_APP_*`), a scoped
  PAT, or (on Forgejo) a scoped `CRABD_FORGEJO_TOKEN`; the git credential and prompt guidance are
  forge-aware. The token broker stays single-repo by design (`repos.read` is ignored under it, with a
  log note).
- **`sandbox.env` + `sandbox.npmrc`** authenticate `pnpm`/`npm install` against private registries:
  forward named CI-secret env vars into the shell, and write a managed `.npmrc` (via
  `NPM_CONFIG_USERCONFIG`, never clobbering the repo's own) whose auth lines reference tokens by
  env-var name — no secret literal touches config or disk. GitHub Packages in the same org can reuse
  the forge token.
- Both sections are **governance-lockable** (`repos.read`, `sandbox.env`, `sandbox.npmrc`) so an org
  can forbid repos from self-granting cross-repo or secret access. The built-in prompt now reflects
  any granted cross-repo access. The action image adds the `gh` CLI.

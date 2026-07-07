---
title: Cross-repo access & private registries
description: Let the agent read other repositories and authenticate private npm registries — all from config, no workflow changes.
---

By default the agent sees exactly one repository (the one it was triggered on) and a sealed shell with
no credentials. Two opt-in, config-only features widen that when a task needs it — reading **other
repositories** and installing from **private registries** — without any change to your workflow YAML.

Both put credentials in front of the model, so read [the security note](#security) first, and prefer
locking them at the org level.

## Read other repositories

Set [`repos.read`](/reference/config-yaml/#repos) in `.crabd.yml`:

```yaml
repos:
  read: [acme/infra, acme/design-system]   # explicit list (globs like acme/* allowed)
  # read: all                               # or the whole App installation
```

crab'd mints a **read-only** forge token scoped to what you allow, exposes it to the model's shell as
`GH_TOKEN` (with `git` preconfigured to use it), and tells the agent it may read those repos — using
`gh api` for a single file, or `git clone` for a whole repo. It can **never write** to them; its
commits only ever land in the trigger repo.

### Requirements

Cross-repo access needs a **cross-repo-capable token**:

- **Your own GitHub App** (`CRABD_APP_*`) — recommended. crab'd mints a least-privilege token scoped
  to exactly the repos you list (`contents: read`, `metadata: read`). The App must be installed on
  those repos.
- **A scoped PAT** (via `CRABD_GITHUB_TOKEN`) — used as-is; scope it yourself to the repos you need.

The default **token broker vends single-repo tokens by design**, so `repos.read` is **ignored** under
it (crab'd logs a note). Switch to your own App or a PAT for cross-repo access. See
[Bot identity](/identity/).

### Forgejo

Forgejo has no GitHub App or broker — identity is a bot-account **access token**
(`CRABD_FORGEJO_TOKEN`). Cross-repo read works the same way: create the token with access to the repos
you need, set `repos.read`, and crab'd exposes it to the shell with `git` preconfigured for your
instance host. The scope is whatever the token was granted (crab'd can't re-scope it, so grant only
what's needed). `gh` is GitHub-only, so on Forgejo the agent uses `git` or the Forgejo API
(`/api/v1`).

## Private npm registries

Authenticate `pnpm`/`npm install` against a private registry with
[`sandbox`](/reference/config-yaml/#sandbox):

```yaml
sandbox:
  npmrc:
    - registry: https://registry.npmjs.org
      scope: "@myorg"
      token_env: NPM_TOKEN   # referenced as ${NPM_TOKEN} in the .npmrc
```

crab'd writes a **managed `.npmrc`** before the run (pointed at via `NPM_CONFIG_USERCONFIG`, so it
never clobbers the repo's own) whose auth lines reference your token by env-var name — the token value
is never written to disk or into config. The `token_env` var is forwarded into the shell **on its
own**, so `pnpm install` can expand it; you don't also list it under `sandbox.env`.

Provide the secret **once** as an env var on the crab'd step (a secret can't live in config), naming
it to match `token_env`:

```yaml title="workflow"
- uses: actions/checkout@v4
- uses: louisescher/crabd@v0
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**GitHub Packages, same org:** omit `token_env` and crab'd falls back to the exposed forge token — no
extra secret — as long as your App was granted `packages: read`.

If your repo already ships an `.npmrc` that references an env var, you can skip `sandbox.npmrc` and
just forward the var with `sandbox.env`.

## Security

The model's shell is **network-capable and crab'd does not restrict its egress**, so anything you
expose to it can be read and exfiltrated by model-run commands. Mitigations:

- **Least privilege.** `repos.read` mints a **read-only** token; scope it to specific repos, not
  `all`, when you can.
- **Secrets stay in CI secrets** and are referenced by env-var name — never put a token in `.crabd.yml`.
- **Org lock.** `repos.read`, `sandbox.env`, and `sandbox.npmrc` are
  [governance-lockable](/config-layering/#governance-locking) so individual repos can't self-grant
  cross-repo or secret access:

  ```yaml title="org .crabd.yml"
  governance:
    locked: [repos.read, sandbox.env, sandbox.npmrc]
  ```

See [Data egress & security](/data-egress/#the-sandbox) for the full posture.

---
title: Data egress & security
description: What leaves your CI, who can trigger crab'd, and how an org keeps control.
---

crab'd runs in your CI with access to the checked-out repo and a forge token.

## What leaves the runner

- **Repo content → the model provider.** Prompts (diffs, file contents, comments) go to the provider
  behind your chosen `model`. This is the main egress path.
- **Forge API calls.** Comments, reviews, commits, and PRs, authenticated as crab'd's
  [identity](/identity/).
- **MCP servers.** If configured, the agent may send data to them.
- **Web search.** When `web_search.enabled` (default), the agent's search queries go to the search
  provider (Tavily or DuckDuckGo). Set `web_search.enabled: false` to disable.

Provider and forge **credentials** are read from the environment and never written to logs, config, or
comments.

## Control who can trigger

crab'd only acts for allowlisted author-associations, and **never for bots** (which prevents comment
loops):

```yaml title=".crabd.yml"
permissions:
  allowed_associations: [OWNER, MEMBER, COLLABORATOR]
```

An unauthorized actor's mention is ignored before any model call.

## Control which providers see your code

The [provider allowlist](/providers/#the-provider-allowlist) is the core egress guardrail. It is
**empty by default (any provider allowed)** so crab'd works with zero config — set it to restrict.
Once set, a model whose provider isn't listed fails the run *before* anything is sent:

```yaml title=".crabd.yml"
providers:
  allowlist: [anthropic]
```

Route approved providers through your own proxy with the
[egress gateway](/providers/openai-compatible/#egress-gateway) for centralized logging or filtering.

## Lock it at the org level

A repo can otherwise set its own `providers.allowlist`. Lock it in the org config so no repo can route
code to an unapproved provider or a custom URL:

```yaml title="<owner>/.crabd-config/.crabd.yml"
providers:
  allowlist: [anthropic]
  gateway_url: https://gateway.example.com
governance:
  locked: [providers.allowlist, providers.custom, providers.gateway_url]
```

Locked keys can't be overridden by the repo file, CI inputs, or env. See
[Config layering & governance](/config-layering/#governance-locking).

## The sandbox

The agent edits code in a **local sandbox** rooted at the checked-out repo. Its shell/tools get an
**empty env allowlist by default**, no host secrets leak into the model's bash tool. Expose specific
vars only when a task needs them — via the [`sandbox`](/reference/config-yaml/#sandbox) config (or
the low-level `CRABD_SANDBOX_ENV`).

Two opt-in features deliberately put credentials in front of the model (see
[Cross-repo access & private registries](/access/)):

- [`repos.read`](/reference/config-yaml/#repos) exposes a **read-only, least-privilege** forge token
  (scoped to just the repos you allow) as `GH_TOKEN`, so the agent can read other repos.
- [`sandbox.env`](/reference/config-yaml/#sandbox) forwards named secrets (e.g. a registry token),
  and `sandbox.npmrc` writes a managed `.npmrc` referencing them.

Both are **governance-lockable** (`repos.read`, `sandbox.env`, `sandbox.npmrc`) so an org can forbid
individual repos from self-granting them.

:::caution
crab'd does **not** restrict the sandbox's outbound network. Flue's local sandbox exposes no
egress allowlist. Treat the model's shell as network-capable — **anything you expose to it
(a forge token, a registry secret) can be read and exfiltrated by model-run commands.** Prefer the
narrowest scope (`repos.read` mints a read-only token; scope it to specific repos, not `all`), keep
secrets in CI secrets (never in `.crabd.yml`), and lock these keys at the org level.
:::

## Checklist for a locked-down org

- [ ] Org `.crabd.yml` sets and **locks** `providers.allowlist`.
- [ ] `permissions.allowed_associations` restricted to trusted roles.
- [ ] Full prompt override disabled except for named repos (`governance.full_override_repos`).
- [ ] Provider keys and forge credentials in secrets, never in `.crabd.yml`.
- [ ] Lock `repos.read`, `sandbox.env`, `sandbox.npmrc` if repos shouldn't self-grant cross-repo/secret access.
- [ ] Optional: route providers through an egress `gateway_url`.

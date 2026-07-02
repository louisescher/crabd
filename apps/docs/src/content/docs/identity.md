---
title: Bot identity & the token broker
description: How crab'd authenticates and whose name appears on its comments.
---

The single most confusing part of any CI agent is **whose identity it posts as**. On GitHub, a comment
is attributed to a *bot* only when you authenticate as a **GitHub App installation**. crab'd supports
three identity paths; this explains each and how it picks.

## Resolution order

crab'd chooses the first that applies:

1. **Your own App**: if `CRABD_APP_ID` + `CRABD_APP_PRIVATE_KEY` are set.
2. **Canonical `crab'd[bot]` via the broker**: if OIDC is available (`id-token: write`) and the
   broker isn't disabled.
3. **Workflow token**: `GITHUB_TOKEN` fallback, comments come from `github-actions`.

## 1. Canonical crab'd[bot] (broker)

One published crab'd App, whose private key lives **only** in a token-broker service. You never hold
the key, you just install the App and grant OIDC.

How a run authenticates:

1. The action asks GitHub for an **OIDC token** (needs `permissions: id-token: write`), scoped to the
   broker's audience.
2. It POSTs that token to the broker.
3. The broker **verifies** it (GitHub's JWKS, issuer, audience), reads the `repository` claim, and
   confirms the crab'd App is installed there.
4. The broker mints a **short-lived, single-repo-scoped** installation token and returns it.

The App key never leaves the broker, and a token is only ever vended for the repo the OIDC proof came
from, so it can't be used to reach other repos.

```yaml title="workflow"
permissions:
  contents: write
  pull-requests: write
  issues: write
  id-token: write
steps:
  - uses: actions/checkout@v4
  - uses: louisescher/crabd@v1
    with:
      model: anthropic/claude-sonnet-4-6
```

Run your own broker (`@crabd/broker`, Node or Cloudflare) and point at it with `broker-url`, see
[Operating crab'd → run your own broker](/self-hosting/#run-your-own-broker).

## 2. Your own GitHub App

Hold the key yourself. Good for a single org that doesn't want to depend on a broker. Create the App
from the [manifest](/self-hosting/#authentication--identity), install it, and pass its credentials:

```yaml title="workflow"
- uses: louisescher/crabd@v1
  with:
    app-id: ${{ secrets.CRABD_APP_ID }}
    app-private-key: ${{ secrets.CRABD_APP_PRIVATE_KEY }}
```

The installation ID is **auto-resolved** from the repo. Because App credentials take priority, this
also lets a specific repo run a differently-branded App than the org default.

## 3. Workflow token (github-actions)

No App, no broker, just the workflow's `GITHUB_TOKEN`. Simplest, but comments come from the
`github-actions` bot and it can't read a separate [org config repo](/config-layering/).

## Forgejo

Forgejo has no GitHub App equivalent, so identity is **whatever bot account owns
`CRABD_FORGEJO_TOKEN`**. Create a dedicated bot user; its name and avatar become crab'd's identity on
that instance. (No OIDC/broker on Forgejo, there, "it's down to the workflow.")

## Which should I use?

| Situation | Use |
| --- | --- |
| Many orgs, one shared `crab'd[bot]` | Broker |
| One org, no service to run | Your own App |
| Quick test / functionality only | Workflow token |
| Forgejo | Bot-account token |

---
title: Operating crab'd
description: Authentication, org config access, trust, and Forgejo setup.
---

This page covers running crab'd for a team: how it authenticates, how it reads org-wide config, who
may trigger it, and how Forgejo differs from GitHub.

## Authentication & identity

crab'd needs a forge token to fetch context and post results. **How it authenticates decides whose
name appears on the comments.**

### Canonical crab'd[bot] via the token broker (default)

By default crab'd posts as the one canonical **crab'd[bot]** without you handling any App key. It
works via a **token broker**: the action mints a GitHub **OIDC** token, the broker verifies it,
confirms the crab'd App is installed on your repo, and vends a short-lived, repo-scoped installation
token. The App's private key lives only on the broker.

To use it:

1. Install the crab'd GitHub App on your repos.
2. Give the job `id-token: write` and nothing else for identity:

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

The broker only vends a token for a repo the OIDC claim proves the run came from **and** where the
App is installed, so it can't be used to reach other repos.

### Run your own broker

The broker is `@crabd/broker`, a small fetch-native service (Node or Cloudflare). Give it the crab'd
App credentials and point the action at it:

```bash
CRABD_APP_ID=... CRABD_APP_PRIVATE_KEY=... CRABD_BROKER_AUDIENCE=crabd-broker crabd-broker
```

```yaml title="workflow"
- uses: louisescher/crabd@v1
  with:
    broker-url: https://your-broker.example.com
```

### Bring your own App (no broker)

Prefer to hold the key yourself? Open `app/register.html`. It opens GitHub's *New GitHub App* form
pre-filled (no server needed). Create the App, generate a private key, install it, then store
`CRABD_APP_ID` / `CRABD_APP_PRIVATE_KEY` as secrets and pass them as `app-id` / `app-private-key`. The
installation ID is auto-resolved. This overrides the broker path. See
[`app/README.md`](https://github.com/louisescher/crabd/blob/main/app/README.md) for the full walkthrough.

### Token (github-actions identity)

For a single repo without an App, the workflow's `GITHUB_TOKEN` works — but comments come from the
`github-actions` bot, and it's **repo-scoped** so it can't read a separate org config repo.

### Ready-made workflows

Copy a starting workflow from the repo's [`workflows/`](https://github.com/louisescher/crabd/tree/main/workflows)
directory: `workflows/github/crabd.yml` and `workflows/forgejo/crabd.yml`.

## Who can trigger crab'd

crab'd only acts for actors whose association is allowlisted, and never for bots (to avoid comment
loops):

```yaml title=".crabd.yml"
permissions:
  allowed_associations: [OWNER, MEMBER, COLLABORATOR]
```

Lock this at the org level to keep it consistent across repos.

## Data egress

Repo content is sent only to [allowlisted providers](/providers/#the-provider-allowlist). Lock
`providers.allowlist` in the org config, and optionally route everything through an
[egress gateway](/providers/#egress-gateway). Provider keys are read from the environment and never
appear in config, logs, or comments.

## Forgejo

crab'd runs on Forgejo Actions the same way it runs on GitHub Actions. Forgejo exposes
GitHub-compatible event payloads, so triggering is identical. Two differences:

- **Auth is token-only.** Forgejo has no GitHub App equivalent, so use a scoped access token.
- **Point crab'd at the API root.** Set the Forgejo API base and token:

```yaml title="workflow env"
CRABD_FORGE: forgejo
CRABD_FORGEJO_API_URL: https://forgejo.example.com/api/v1
CRABD_FORGEJO_TOKEN: ${{ secrets.CRABD_FORGEJO_TOKEN }}
```

Everything else (`.crabd.yml`, modes, providers, output schemas) is identical.

---
name: add-crabd-to-repo
description: Add crab'd to a GitHub or Forgejo repository from scratch — the workflow file, identity/auth, provider key, and a starter .crabd.yml. Use when a repo has no crab'd setup yet.
---

# Add crab'd to a repo

Set up crab'd on a repo that doesn't have it yet.

## 1. Detect the forge

- **GitHub** → workflow at `.github/workflows/crabd.yml`, events + App/OIDC identity.
- **Forgejo** → `.forgejo/workflows/crabd.yml`, token identity.

Copy the matching starter from the crab'd repo's `workflows/` directory.

## 2. Choose identity (GitHub)

Explain the options and pick with the user (see the Identity docs):

1. **Canonical crab'd[bot]** — install the crab'd App, add `permissions: id-token: write`. No secrets.
2. **Your own App** — create from the manifest, store `CRABD_APP_ID` / `CRABD_APP_PRIVATE_KEY`.
3. **Workflow token** — simplest, but comments come from `github-actions`.

For **Forgejo**: create a bot account, generate a token, store it as `CRABD_FORGEJO_TOKEN`, and set
`CRABD_FORGEJO_API_URL`.

## 3. Provider key

Add the secret for the chosen model provider (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, …) and reference it in the workflow `env:`.

## 4. Starter `.crabd.yml`

Minimal is fine — crab'd works with almost no config:

```yaml
model: anthropic/claude-sonnet-5
```

Add `providers.allowlist`, `permissions`, and `prompt.instructions` if the user wants restrictions or
house rules. (Consider the `configure-crabd` skill for a fuller config.)

## 5. Commit & test

Commit the workflow (and `.crabd.yml`), then trigger a run: comment `/crabd hello` on an issue, or
open a PR. Confirm the 👀 reaction and the tracking comment appear, and that the bot identity is what
you expect.

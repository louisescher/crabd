---
title: Getting started
description: Add crab'd to your CI and trigger your first run.
---

This guide gets crab'd running on a repository in a few minutes. You'll add a workflow, give it a
model key, and mention crab'd on an issue.

## Prerequisites

- A repository on **GitHub** or **Forgejo**.
- An API key for at least one model provider (for example `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`),
  stored as a CI secret.

## Add the workflow

Create `.github/workflows/crabd.yml` (or `.forgejo/workflows/crabd.yml` on Forgejo):

```yaml title=".github/workflows/crabd.yml"
name: crab'd
on:
  issue_comment:
    types: [created]
  pull_request:
    types: [opened, reopened, ready_for_review]
  issues:
    types: [assigned, labeled]

jobs:
  crabd:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
      - uses: louisescher/crabd@v0
        with:
          model: anthropic/claude-sonnet-4-6
          providers: anthropic
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

:::note
`id-token: write` lets crab'd post as the canonical **crab'd[bot]** via the token broker — install the
crab'd GitHub App on your repo first. Prefer to hold your own key, or no App at all? See
[Operating crab'd](/self-hosting/#authentication--identity).
:::

:::note
crab'd reads the model provider key straight from the environment (`ANTHROPIC_API_KEY`,
`OPENAI_API_KEY`, `OPENROUTER_API_KEY`, ...). Keep it in CI secrets — never in `.crabd.yml`.
:::

## Trigger your first run

Once the workflow is committed, try any of these:

- **Mention** — comment `/crabd how does the auth middleware work?` on an issue or PR.
- **Review** — open a pull request; crab'd reviews the diff automatically.
- **Implement** — assign an issue to crab'd (or label it) to have it open a PR.

crab'd posts a "working..." comment, then updates it in place with the result.

## Steer a run

Anything you write after the mention is passed to the agent, so you can steer any mode:

```text
/crabd review — focus on the database migration and error handling
```

## Next steps

- [Configuration](/configuration/) — every dial, layered config, and governance.
- [Providers](/providers/) — use OpenAI, OpenRouter, or a local model.
- [Modes](/modes/) — how mention, review, and implement behave.

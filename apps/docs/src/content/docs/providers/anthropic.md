---
title: Anthropic (Claude)
description: Use Claude models with crab'd.
---

Claude models run through the built-in **`anthropic`** provider.

## Setup

1. Create an API key in the [Anthropic Console](https://console.anthropic.com/).
2. Store it as a repo/org secret named `ANTHROPIC_API_KEY` and pass it in the workflow `env:`.
3. Select a Claude model and allowlist the provider in `.crabd.yml`.

```yaml title=".crabd.yml"
model: anthropic/claude-sonnet-4-6
providers:
  allowlist: [anthropic]
```

```yaml title="workflow"
- uses: louisescher/crabd@v0
  with:
    model: anthropic/claude-sonnet-4-6
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

## Model specifiers

Use `anthropic/<model>`, for example:

- `anthropic/claude-opus-4-8`: most capable, for hard implementation work.
- `anthropic/claude-sonnet-5`: balanced default.
- `anthropic/claude-haiku-4-5`: fastest/cheapest, good for triage and light review.

## Tips

- Set a per-mode model to spend more only where it matters, e.g. Opus for `implement`, Haiku for
  `review`:

  ```yaml title=".crabd.yml"
  model: anthropic/claude-haiku-4-5
  modes:
    implement:
      model: anthropic/claude-opus-4-6
  ```

- `thinking_level` (e.g. `high`) increases reasoning effort for Claude models that support it.

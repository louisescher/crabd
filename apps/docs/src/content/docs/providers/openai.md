---
title: OpenAI
description: Use OpenAI models with crab'd.
---

OpenAI models run through the built-in **`openai`** provider.

## Setup

1. Create an API key in the [OpenAI dashboard](https://platform.openai.com/api-keys).
2. Store it as a repo/org secret named `OPENAI_API_KEY` and pass it in the workflow `env:`.
3. Select a model and allowlist the provider in `.crabd.yml`.

```yaml title=".crabd.yml"
model: openai/gpt-5.5
providers:
  allowlist: [openai]
```

```yaml title="workflow"
- uses: louisescher/crabd@v1
  with:
    model: openai/gpt-5.5
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

## Model specifiers

Use `openai/<model>`, e.g. `openai/gpt-5.5`. Any model ID your key can access works.

## Tips

- Mix providers per mode, e.g. review with OpenAI, implement with Claude, as long as both providers
  are allowlisted:

  ```yaml title=".crabd.yml"
  providers:
    allowlist: [anthropic, openai]
  modes:
    review:
      model: openai/gpt-5.5
  ```

- To reach OpenAI through Azure or a proxy, use a [custom provider](/providers/openai-compatible/) or
  the [egress gateway](/providers/openai-compatible/#egress-gateway).

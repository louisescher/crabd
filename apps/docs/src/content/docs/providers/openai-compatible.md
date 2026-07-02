---
title: OpenAI-compatible & local
description: Point crab'd at any OpenAI-compatible endpoint, a local model, or an egress gateway.
---

Beyond the built-in providers, crab'd can talk to **any OpenAI-compatible endpoint** (a self-hosted
model, an internal proxy, a niche vendor, or a local runtime) via `providers.custom`.

## Custom provider

Declare the provider; its `id` becomes usable in model specifiers.

```yaml title=".crabd.yml"
providers:
  allowlist: [my-llm]          # a custom id must be allowlisted to be used
  custom:
    - id: my-llm
      base_url: https://llm.internal/v1
      api: openai-completions   # optional; the default
      api_key_env: MY_LLM_KEY   # optional; env var holding the key

model: my-llm/some-model
```

```yaml title="workflow"
- uses: louisescher/crabd@v0
  env:
    MY_LLM_KEY: ${{ secrets.MY_LLM_KEY }}
```

| Field | Description |
| --- | --- |
| `id` | Provider ID used in specifiers (`my-llm/model`). |
| `base_url` | OpenAI-compatible endpoint root. |
| `api` | Wire protocol. Default `openai-completions`. |
| `api_key_env` | Env var whose value is the API key. |

:::caution
A custom provider ID must **also** be in `providers.allowlist`. An org can lock `providers.allowlist` / `providers.custom` so repos can't route code to an arbitrary URL.
:::

## Local models (Ollama)

Ollama is a custom provider with a shortcut. Set its base URL via env and use `ollama/*`:

```yaml title="workflow env"
CRABD_OLLAMA_BASE_URL: http://localhost:11434/v1
```

```yaml title=".crabd.yml"
model: ollama/llama3.1:8b
providers:
  allowlist: [ollama]
```

## Egress gateway

To route **built-in** providers through a gateway or proxy (central logging, caching, data-egress
control) without changing model specifiers, set `providers.gateway_url`:

```yaml title=".crabd.yml"
providers:
  allowlist: [anthropic, openai]
  gateway_url: https://gateway.example.com
```

Each allowlisted built-in provider is then reached at `${gateway_url}/<provider>` (e.g.
`https://gateway.example.com/anthropic`), keeping its normal credentials. Custom providers and
`ollama` are untouched.

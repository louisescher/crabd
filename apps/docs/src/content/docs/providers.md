---
title: Providers overview
description: How crab'd selects models and which providers are supported.
---

crab'd is model-agnostic. A model is chosen with a **`<provider>/<model>`** specifier; the provider
decides how the request is authenticated and routed.

```yaml title=".crabd.yml"
model: anthropic/claude-sonnet-4-6

modes:
  review:
    model: openai/gpt-5.5   # per-mode override
```

## Provider guides

| Provider | ID(s) | Guide |
| --- | --- | --- |
| Anthropic (Claude) | `anthropic` | [Anthropic](/providers/anthropic/) |
| OpenAI | `openai` | [OpenAI](/providers/openai/) |
| Google (Gemini, Vertex AI) | `google`, `google-vertex` | [Google](/providers/google/) |
| OpenAI-compatible / local | your `id`, `ollama` | [OpenAI-compatible & local](/providers/openai-compatible/) |

OpenRouter (`openrouter`, key `OPENROUTER_API_KEY`) and other Pi-catalog providers work the same way.
Pick a `<provider>/<model>` specifier and supply the provider's credential.

## The provider allowlist

By default the allowlist is **empty, which allows any provider** — crab'd works with zero config. Set
it to restrict which providers your repo code may reach; then any model whose provider isn't listed
fails the run before a byte leaves your CI:

```yaml title=".crabd.yml"
providers:
  allowlist: [anthropic, openai]
```

:::tip
Lock the allowlist at the org level so no repo can switch to an unapproved provider. See
[org governance](/configuration/#org-governance) and [data egress](/reference/config-yaml/#providers).
:::

## Routing & self-hosting

- Route built-in providers through a proxy with the [egress gateway](/providers/openai-compatible/#egress-gateway).
- Point at any OpenAI-compatible URL with a [custom provider](/providers/openai-compatible/).

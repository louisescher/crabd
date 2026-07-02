---
title: .crabd.yml
description: Every field of the crab'd YAML configuration file, with types and defaults.
---

The complete `.crabd.yml` schema. Every field is optional, omitting anything will cause crab'd to use the built-in
default. For how these values combine across the org repo, the repo file, CI inputs, and env, see
[Configuration](/configuration/#how-layers-merge).

## Top level

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | `1` | Config schema version. |
| `model` | `string` | `anthropic/claude-sonnet-5` | Default model specifier, `<provider>/<model>`. Its provider must be allowlisted. |
| `trigger_phrase` | `string` | `@crabd` | The mention phrase that triggers crab'd. |
| `thinking_level` | `'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` | `medium` | Reasoning effort. |
| `providers` | `object` | — | Provider allowlist, gateway, and custom providers. See below. |
| `permissions` | `object` | — | Who may trigger crab'd. See below. |
| `prompt` | `object` | — | Prompt customization. See below. |
| `limits` | `object` | — | Run limits. See below. |
| `modes` | `map<string, Mode>` | built-ins enabled | Per-mode configuration. See below. |
| `mcp` | `McpServer[]` | `[]` | Remote MCP servers whose tools the agent may call. **Reconciled by `name`** across layers. See below. |
| `governance` | `object` | — | **Org config repo only.** Locking and override allowlist. See below. |

## `providers`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowlist` | `string[]` | `[]` | Provider IDs crab'd may use. **Empty means allow any provider** (zero-config default). Set it — and lock it at the org level — to restrict egress; then a model or custom provider must be listed to be usable. |
| `gateway_url` | `string \| null` | `null` | Org egress gateway. When set, each allowlisted built-in provider is routed through `${gateway_url}/<provider>`, keeping its normal credentials. |
| `custom` | `CustomProvider[]` | `[]` | User-defined providers. **Reconciled by `id`** across layers — repos reuse org entries and add/override their own. |

### `CustomProvider`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | — | Provider ID used in model specifiers (e.g. `my-llm` in `my-llm/model`). |
| `base_url` | `string` | — | Endpoint root, e.g. `https://llm.internal/v1`. |
| `api` | `string` | `openai-completions` | Wire-protocol slug. |
| `api_key_env` | `string` | — | Env var whose value is used as the API key. |

## `permissions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowed_associations` | `string[]` | `[OWNER, MEMBER, COLLABORATOR]` | Author-associations allowed to trigger crab'd. Bots are always denied. |

## `prompt`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `instructions` | `string` | `''` | Extra instructions appended to the base prompt. **Accumulates across all layers.** |
| `allow_full_override` | `boolean` | `false` | Repo opt-in to replace the base prompt. Only effective if the org allowlists this repo via `governance.full_override_repos`. |
| `override` | `string` | — | The replacement system prompt used when full override is permitted. |

## `limits`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `max_turns` | `number` | `40` | **Hard ceiling** on tool-calling turns — the run is aborted if it's exceeded. Not injected into the prompt, so it doesn't bias the model into finishing early. |
| `timeout_minutes` | `number` | — | **Hard** wall-clock limit, enforced via the agent's durability timeout. |

## `modes.<name>`

Keys are mode names. Built-ins: `mention`, `review`, `implement`. Add your own via
[`crabd.config.ts`](/reference/crabd-config-ts/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether this mode may run. |
| `model` | `string` | inherits `model` | Per-mode model override (allowlist-gated). |
| `instructions` | `string` | `''` | Per-mode instructions appended to the prompt. **Accumulates across layers.** |
| `thinking_level` | same as top-level | inherits | Per-mode reasoning override. |
| `tools` | `string[]` | per built-in | Forge operations the mode uses (`comment`, `commit`, `review`, `open_pr`). Replaced by the highest layer. |

Built-in defaults: `mention` → `[comment, commit]`, `review` → `[comment, review]`, `implement` →
`[comment, commit, open_pr]`.

## `mcp[]`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | — | Server name; tools are exposed as `mcp__<name>__<tool>`. |
| `url` | `string` | — | MCP server endpoint. |
| `transport` | `'streamable-http' \| 'sse'` | `streamable-http` | Remote transport. |
| `headers` | `map<string, string>` | — | Headers sent to the MCP server. |

## `governance`

Only meaningful in the **org config repo's** `.crabd.yml`.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `locked` | `string[]` | `[]` | Dot-paths (e.g. `providers.allowlist`) that lower layers cannot override. |
| `full_override_repos` | `string[]` | `[]` | Repo slugs (`owner/repo`) permitted to use full prompt override. |

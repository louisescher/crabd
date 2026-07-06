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
| `trigger_phrase` | `string` | `/crabd` | The mention phrase that triggers crab'd. |
| `thinking_level` | `'off' \| 'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh'` | `medium` | Reasoning effort. |
| `providers` | `object` | — | Provider allowlist, gateway, and custom providers. See below. |
| `permissions` | `object` | — | Who may trigger crab'd. See below. |
| `appearance` | `object` | — | Name, emoji, and footer crab'd uses in its comments. See below. |
| `review` | `object` | — | Review-mode behavior. See below. |
| `web_search` | `object` | — | Web research tools for the agent. See below. |
| `prompt` | `object` | — | Prompt customization. See below. |
| `limits` | `object` | — | Run limits. See below. |
| `rate_limit` | `object` | — | Backoff, retry, and fallback-model behavior when a provider rate-limits crab'd. See below. |
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

## `appearance`

Controls how crab'd presents itself in the tracking comment it posts and updates. Use it to rename
the bot or match a house style. Only the **brand emoji** (`🦀`) is governed here — status glyphs
(⚠️ error, ⏳ rate-limited, ➡️ PR opened) are always shown as semantic cues.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `name` | `string` | `crab'd` | Display name crab'd uses when it refers to itself (e.g. "**DevBot** is working…"). A blank value falls back to the default. |
| `emoji` | `string` | `🦀` | Emoji prefixed to comment leads and the footer. Set to `""` (empty string) to show **no** emoji. |
| `footer` | `boolean` | `true` | Whether the `posted by <name>` footer (with the link back to the crab'd project) is shown. Set `false` to drop it entirely. The hidden marker crab'd uses to find and update its own comment is always kept, so sticky reuse still works. |

```yaml
# Rebrand the bot and drop the footer
appearance:
  name: DevBot
  emoji: "🐙"
  footer: false
```

```yaml
# Keep the name, remove every crab
appearance:
  emoji: ""
```

## `review`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `comment_only` | `boolean` | `false` | When `true`, crab'd posts every review as a plain **comment**. It never formally approves or requests changes, so it can't approve or block a PR. The verdict is still computed and shown in the summary. |

The review verdict maps to a plain-language line in the summary (and, unless `comment_only`, to the
forge review action):

| Summary says | Forge review |
| --- | --- |
| **Good to merge (LGTM)** | Approve |
| **Nits found** | Comment |
| **Please address the findings before merging** | Request changes |

## `web_search`

Gives the agent `web_search` and `fetch_url` tools so it can research current information (library
versions, changelogs, APIs, issues) instead of relying on stale training data.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether the agent gets the web tools. |
| `max_results` | `number` | `5` | Max results per search. |

Search uses [Tavily](https://tavily.com) when `TAVILY_API_KEY` is set (recommended, reliable), and
falls back to a best-effort keyless DuckDuckGo search otherwise. `fetch_url` needs no key.

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

## `rate_limit`

Controls what crab'd does when a provider rate-limits or overloads a model. See
[Rate limiting & fallback models](/reference/rate-limiting/) for the full picture, including why
crab'd's main lever is falling back to a **different** model.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `fallback_models` | `string[]` | `[]` | Ordered fallback chain (`<provider>/<model>`), tried in order after the primary is rate-limited. Cross-provider. Empty = no fallback. **Replaced (not merged)** by the highest layer. Each entry's provider must be **allowlisted** (like `model`) — a non-allowlisted fallback fails the run at startup. |
| `max_retries` | `number` | `4` | Cap on crab'd-level attempts across the chain (primary + fallbacks). |
| `max_wait_seconds` | `number` | `180` | Total wall-clock budget crab'd spends handling rate limits before giving up. Caps CI minutes burned waiting. |
| `trigger_scope` | `'transient' \| 'rate-limit' \| 'all'` | `transient` | Which errors trigger retry/fallback. `transient` = rate limits, 5xx/network/timeout, and quota/billing (cross-provider fallback only). `rate-limit` = only 429 / 529 / "rate limit" / "overloaded". `all` = any error. |
| `on_exhausted` | `'soft' \| 'fail'` | per-mode | What to do once the chain/budget is exhausted. Unset = per-mode default: **`review` soft-finishes** (green check, won't block PRs), other modes **fail** the check. Set explicitly to force one behavior. |
| `backoff` | `object` | — | Backoff between attempts / model switches. See below. |

### `rate_limit.backoff`

Delays are **computed** — crab'd cannot honor a provider's `retry-after` header (the underlying
framework doesn't expose it) — and they stack on top of the framework's own per-model retries.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `strategy` | `'exponential' \| 'linear' \| 'constant'` | `exponential` | How the delay grows per attempt. |
| `initial_delay_seconds` | `number` | `2` | Base delay for the first backoff. |
| `max_delay_seconds` | `number` | `30` | Upper clamp on any single delay. |
| `multiplier` | `number` | `2` | Growth factor (exponential base / linear step). |
| `jitter` | `boolean` | `true` | Equal jitter (keeps 0.5×–1× of the delay) to avoid a thundering herd. |

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

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
| `permissions` | `object` | — | Who may trigger crab'd, and whether it may write. See below. |
| `appearance` | `object` | — | Name, emoji, and footer crab'd uses in its comments. See below. |
| `review` | `object` | — | Review-mode behavior. See below. |
| `web_search` | `object` | — | Web research tools for the agent. See below. |
| `context` | `object` | — | Repo-authored context (`AGENTS.md`/`CLAUDE.md`, skills) crab'd pulls into the prompt. See below. |
| `repos` | `object` | — | Cross-repo **read** access for the agent. See below. |
| `sandbox` | `object` | — | Extra environment for the model's shell: forwarded secrets + private-registry `.npmrc`. See below. |
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
| `custom` | `CustomProvider[]` | `[]` | User-defined providers. **Reconciled by `id`** across layers, merging field by field — a layer that sets only `base_url` keeps the lower layer's other fields. |

### `CustomProvider`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `id` | `string` | — | Provider ID used in model specifiers (e.g. `my-llm` in `my-llm/model`). |
| `base_url` | `string` | — | Endpoint root, e.g. `https://llm.internal/v1`. |
| `api` | `string` | `openai-completions` | Wire-protocol slug. |
| `api_key_env` | `string` | — | Env var whose value is used as the API key. |
| `context_window` | `number` | — | Total window (input + output) in tokens. Required for model IDs the built-in catalog does not know: see [Sizing a self-hosted model](#sizing-a-self-hosted-model). |
| `max_tokens` | `number` | — | Per-response output cap. Omit to let the endpoint apply its own default (for vLLM, the whole window minus the prompt). |
| `reasoning` | `boolean` | `false` | Whether the served model produces reasoning output. Required for a reasoning model the catalog does not know, or crab'd sends no thinking controls and `thinking_level` has no effect on it. |
| `vision` | `boolean` | `false` | Whether the served model accepts images. Without it, images in a comment are replaced with an `(image omitted)` placeholder rather than answered. |

### Sizing a self-hosted model

crab'd hydrates model metadata from a built-in catalog. A catalog model ID keeps its own window even
behind a custom `base_url`, so nothing extra is needed. A model ID the catalog does not know (your own
alias, e.g. `deepseek-v4-flash-max`) has no metadata, and an unknown window is treated as zero. Two
things then go wrong silently: context compaction fires on every turn, and each request goes out
capped at a single output token, so the model emits one reasoning token, never calls a tool, and the
turn fails after the framework's follow-up ceiling.

Set `context_window` to the window your endpoint serves and the run behaves normally:

```yaml
model: "my-llm/my-alias"
providers:
  allowlist: [my-llm]
  custom:
    - id: my-llm
      base_url: https://llm.internal/v1
      api_key_env: MY_LLM_KEY
      context_window: 1048576
      reasoning: true   # a reasoning model the catalog does not know
      vision: true      # accepts images
```

Leave `max_tokens` unset unless you want to cap responses below what the endpoint allows. With it
unset, crab'd sends no output cap and the endpoint gives each response the whole remaining window.
crab'd warns at startup when a model runs on a custom provider with no `context_window`.

## `permissions`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `allowed_associations` | `string[]` | `[OWNER, MEMBER, COLLABORATOR]` | Author-associations allowed to trigger crab'd. Bots are always denied. |
| `write` | `boolean` | derived | Whether crab'd may change the repository (commit to a branch, open a pull request). Unset, it follows `modes.implement.enabled`: turning implement off also stops `mention` from committing. Set it explicitly to keep one without the other. |

### Read-only runs

`permissions.write: false` closes every write path at once. crab'd still reads, answers, and
reviews; `implement` stops triggering (committing and opening a PR is all it does), `mention`
answers without committing, and the agent is told up front so it describes a change instead of
writing one it cannot land.

```yaml
# Review and answer questions; never touch the code.
permissions:
  write: false
```

Two other things turn it on without you asking:

- **Disabling `implement`.** Switching off the only mode that exists to change the repo reads as
  "crab'd does not write here", so `mention` stops committing too. `permissions.write: true`
  overrides this if you want the mention commits without the PR flow.
- **A token that cannot write.** At startup crab'd asks its token what it was granted. If the
  GitHub App installation only has `contents: read`, the run goes read-only and logs a warning,
  rather than spending the whole turn on a change and failing on a 403 at the commit. Tokens whose
  scope cannot be introspected (a PAT, the workflow `GITHUB_TOKEN`) are treated as unknown, not as
  read-only.

Lock it at the org level so a repo cannot grant itself writes back:

```yaml title="org .crabd.yml"
permissions:
  write: false
governance:
  locked: [permissions.write]
```

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
| `strictness` | `1`–`5` | `2` | The main dial. It sets the confidence a finding needs and which dimensions get reviewed. See below. |
| `min_confidence` | `1`–`10` | from `strictness` | Confidence floor a finding must meet to be posted. Findings below it are dropped before the review is submitted, and reported only as an aggregate count. |
| `max_findings` | `number` | `10` | Cap on inline findings. Findings are ranked by severity then confidence and the tail is dropped, with the count noted. |
| `dimensions` | `string[]` | from `strictness` | Which dimensions to review along. Replaced (not merged) by the highest layer. |
| `exclusions` | `string[]` | `[]` | Extra issue classes crab'd must never report, on top of the built-in list. **Accumulates across all layers.** |
| `precedents` | `string[]` | `[]` | Settled rulings on recurring ambiguous cases. **Accumulates across all layers.** |
| `verify` | object | off | Second-pass refutation of each finding. See [`review.verify`](#reviewverify). |

### How `strictness` works

`strictness` is not a tone knob. It sets two concrete things:

| `strictness` | Confidence floor | Dimensions reviewed |
| --- | --- | --- |
| `1` | 9 | correctness, security |
| `2` (default) | 7 | + concurrency-and-resources, error-handling |
| `3` | 6 | + api-and-compatibility, test-coverage |
| `4` | 5 | all |
| `5` | 4 | all |

Turn it **up** if reviews are too lenient, **down** if they are noisy. Set `min_confidence` or
`dimensions` explicitly to override either half.

At every level, reporting nothing is a valid outcome. crab'd is told not to manufacture findings to
look thorough.

The available dimensions are `correctness`, `security`, `concurrency-and-resources`,
`error-handling`, `efficiency`, `duplication`, `api-and-compatibility`, `test-coverage`, and
`repo-convention`. Each one is also a finding's `category`.

### `exclusions` and `precedents`

Both **accumulate** across config layers rather than being replaced, so an org can pin house rules
and a repo can extend them without silently dropping them:

```yaml
review:
  exclusions:
    - Never comment on the generated client in src/api/generated/.
  precedents:
    - Our request IDs are opaque and need no validation.
```

crab'd already ships a built-in list of both (theoretical races, missing hardening with no concrete
failure, formatting when a formatter owns it, "add a test" without naming the branch, and so on).
These are added to it. Use `exclusions` to retire a false positive permanently instead of
re-litigating it on every PR.

### `review.verify`

Sends each candidate finding to an independent, **blinded** refuter, a subagent that sees the claim
and the code but not the reviewer's reasoning, and posts only what survives. This is the strongest
available lever on false positives, and it costs one extra model call per candidate finding, so it is
off by default.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Whether to run the refutation pass. |
| `min_confidence` | `1`–`10` | `7` | Confidence the refuter needs for a finding to survive, on top of its verdict. |
| `max_concurrency` | `number` | `3` | Refuters in flight at once. |
| `model` | `string` | the review model | Model for the refuters. A cheaper model here keeps the cost down. |

A refuter returns `CONFIRMED`, `REFUTED`, or `UNCERTAIN`. Only a confident `CONFIRMED` is posted. If
a refuter fails or times out, its finding is kept, the pass removes false positives, it does not
swallow the review when an extra call goes wrong.

### Verdicts

The review verdict maps to a plain-language line in the summary (and, unless `comment_only`, to the
forge review action):

| Summary says | Forge review |
| --- | --- |
| **Good to merge (LGTM)** | Approve |
| **Nits found** | Comment |
| **Please address the findings before merging** | Request changes |

crab'd will not approve while a `blocker` or `major` finding stands. A verdict that contradicts the
findings is downgraded to *request changes*.

## `web_search`

Gives the agent `web_search` and `fetch_url` tools so it can research current information (library
versions, changelogs, APIs, issues) instead of relying on stale training data.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Whether the agent gets the web tools. |
| `max_results` | `number` | `5` | Max results per search. |

Search uses [Tavily](https://tavily.com) when `TAVILY_API_KEY` is set (recommended, reliable), and
falls back to a best-effort keyless DuckDuckGo search otherwise. `fetch_url` needs no key.

## `context`

Pulls the repo's **own** agent context into the prompt, so crab'd follows the same conventions your
local agents (Claude Code and others) already do. See [Project context](/project-context/) for the
full behavior.

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `instruction_files` | `boolean` | `true` | Load `AGENTS.md`, then `CLAUDE.md`, from the checkout root and append them to the system prompt (after crab'd's base + `prompt.instructions`, so core rules stay authoritative). Both are read; identical content is included once, differing content is labeled per file. Combined text is capped at 40k chars. |
| `skills` | `boolean` | `true` | Discover skills under `.agents/skills/` and `.claude/skills/` and list each skill's `name` + `description` in the prompt. The agent reads a skill's `SKILL.md` itself when a task matches — the body is never preloaded. A skill with no description is skipped; a skill in both roots is listed once. |
| `full_diff` | `boolean` | `false` | Embed the entire PR diff in the prompt. Off by default: crab'd sends a **compressed** diff instead — low-signal files (lockfiles, generated/minified/vendored output) are dropped, oversized files are clipped to the hunks that fit, and everything omitted is listed so the agent can read a file directly if it needs to. This keeps prompts small and cuts the exploration turns the agent would otherwise spend. Turn it on to send the full diff (clipped only at a 60k-char ceiling). |

## `repos`

Lets the agent **read** repositories besides the one it was triggered on. crab'd mints a
**read-only** token scoped to what you allow and exposes it to the model's shell (as `GH_TOKEN`, with
`git` preconfigured) so it can `gh api` or `git clone` those repos on demand. It can never write to
them. See [Cross-repo access & private registries](/access/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `read` | `'all' \| string[]` | — (off) | `all` grants your App installation's full scope; a list of `owner/repo` (globs like `org/*` allowed) scopes a least-privilege token to those repos. |

Requires a cross-repo-capable token: your **own App** (`CRABD_APP_*`), a scoped **PAT**, or a
**Forgejo access token** (`CRABD_FORGEJO_TOKEN`) with access to those repos. The default **token
broker vends single-repo tokens by design**, so `repos.read` is ignored under it (crab'd logs this).
Governance-lockable at `repos.read`.

```yaml
repos:
  read: [acme/infra, acme/design-system]   # or: read: all
```

## `sandbox`

Extra environment for the model's shell — **off by default** (the sandbox is otherwise sealed). Use it
to authenticate `pnpm`/`npm install` against a private registry. Everything here is readable by the
model, whose shell is network-capable, so only expose what a task needs. Governance-lockable at
`sandbox.env` / `sandbox.npmrc`. See [Cross-repo access & private registries](/access/).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `env` | `string[]` | `[]` | **Names** of env vars (mapped from CI secrets onto the crab'd step) to forward into the shell. Only names live in config; values never do. Replaced by the highest layer. |
| `npmrc` | `NpmRegistry[]` | `[]` | Private registries crab'd authenticates by writing a managed `.npmrc` before the run (pointed at via `NPM_CONFIG_USERCONFIG`, so it never clobbers the repo's own). |

### `NpmRegistry`

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `registry` | `string` | — | Registry URL, e.g. `https://npm.pkg.github.com`. |
| `scope` | `string` | — | Optional package scope this registry serves, e.g. `@myorg`. |
| `token_env` | `string` | — | Env-var name holding the auth token, written as `${NAME}` (expanded at runtime). The var is forwarded automatically. Omit for GitHub Packages in the same org — crab'd falls back to the exposed forge token (needs your **own App** granted `packages: read`; not available under the hosted broker). If the token can't be resolved, crab'd warns and tells the agent the registry is unauthenticated. |

```yaml
# Public npm registry, private scope — needs an auth token.
sandbox:
  npmrc:
    - registry: https://registry.npmjs.org
      scope: "@myorg"
      token_env: NPM_TOKEN   # auto-forwarded; written into the .npmrc as ${NPM_TOKEN}
```

```yaml
# GitHub Packages in the same org — omit token_env; crab'd reuses the forge token
# (needs the App granted `packages: read`).
sandbox:
  npmrc:
    - registry: https://npm.pkg.github.com
      scope: "@myorg"
```

A `token_env` var is forwarded into the shell **on its own** — you don't also list it under
`sandbox.env`. Reserve `sandbox.env` for secrets that **aren't** a registry token (e.g. a repo's
committed `.npmrc` that already references `${SOME_TOKEN}`).

Provide the token once as an env var on the crab'd step — a secret can't live in config, and its
name must match `token_env`:

```yaml title="workflow"
- uses: louisescher/crabd@v0
  env:
    NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

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

---
name: configure-crabd
description: Write or repair a crab'd configuration (.crabd.yml / crabd.config.ts), grounded in the live crab'd documentation. Use when a user wants to set up, change, or debug crab'd config — models, providers, modes, prompts, governance, MCP, or limits.
---

# Configure crab'd

Help the user create or fix their crab'd configuration. **Ground yourself in the current docs first**
so you don't guess at field names or defaults.

## 1. Load the docs

Fetch the full documentation as a single file (replace the host with the user's deployed docs URL, or
ask for it):

- `https://crabd.example.com/llms-full.txt` — complete docs in one file.
- `https://crabd.example.com/llms.txt` — index, if you only need to locate a page.

Read the relevant sections (the `.crabd.yml` reference, Configuration, Providers, Custom prompts)
before writing config.

## 2. Understand intent

Ask only what you can't infer:

- Which **model/provider**? (Anthropic, OpenAI, Google/Gemini, OpenAI-compatible, local.)
- Which **modes** matter (mention / review / implement), and any per-mode model?
- Any **house rules** for the prompt? Any **governance** (org config, locked keys)?
- Limits (`max_turns`, `timeout_minutes`), MCP servers, custom providers?

## 3. Write `.crabd.yml`

Put every dial that fits in YAML here (no build step). Key rules to respect:

- `model` is `<provider>/<model>`; its provider must be allowlisted **if** the allowlist is non-empty.
- `providers.allowlist` empty = allow any provider (zero-config). Set it to restrict.
- `prompt.instructions` (global) and `modes.*.instructions` **accumulate** across layers.
- Full prompt override is governance-gated (org `full_override_repos` + repo opt-in).
- `mcp` and `providers.custom` reconcile by key (`name` / `id`) across layers.
- `max_turns` and `timeout_minutes` are hard limits.
- `rate_limit` tunes provider rate-limit handling: an ordered cross-provider `fallback_models` chain,
  computed `backoff` (no provider `retry-after` is available), a `max_wait_seconds` budget that caps CI
  minutes, `trigger_scope`, and `on_exhausted` (unset = per-mode: `review` soft-finishes green, other
  modes fail). `fallback_models` is a value-list (highest layer replaces).

## 4. Use `crabd.config.ts` only when needed

For output-schema overrides, custom tools, or custom modes — these need valibot (`import * as v from
'valibot'`), **not zod**. See the `crabd.config.ts` reference.

## 5. Validate

- Confirm every model's provider is allowlisted (or the allowlist is intentionally empty).
- Confirm secrets (`ANTHROPIC_API_KEY`, etc.) are referenced from the workflow env, never inlined.
- Summarize what you changed and why.

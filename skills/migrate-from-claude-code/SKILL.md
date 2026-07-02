---
name: migrate-from-claude-code
description: Convert an existing anthropics/claude-code-action workflow to crab'd. Use when a repo already uses claude-code-action (the @claude GitHub Action) and the user wants to move to crab'd, optionally onto a non-Anthropic model or Forgejo.
---

# Migrate from claude-code-action to crab'd

Convert a `claude-code-action` setup to crab'd, preserving behavior while moving to crab'd's
model-agnostic, multi-forge model.

## 1. Find the existing workflow

Locate the workflow using `anthropics/claude-code-action` (usually `.github/workflows/*.yml`). Note
its triggers, `prompt` / mode usage, `model`, `allowed_tools`, `mcp_config`, and any custom
instructions.

## 2. Map the concepts

| claude-code-action | crab'd |
| --- | --- |
| `@claude` mention | `@crabd` mention (set `trigger_phrase` to keep `@claude` if desired) |
| model input (Claude only) | `model: <provider>/<model>` — any provider |
| `custom_instructions` / CLAUDE.md guidance | `prompt.instructions` (global) or per-mode `modes.*.instructions` |
| PR review behavior | `review` mode (fires on PR opened/reopened/ready_for_review, or `@crabd review`) |
| implement / fix an issue | `implement` mode |
| `mcp_config` | `mcp:` servers in `.crabd.yml` |
| `max_turns` / timeout | `limits.max_turns` (hard) / `limits.timeout_minutes` |
| Bedrock/Vertex Claude auth | pick the matching provider (`anthropic`, `google-vertex`, …) |

## 3. Write the crab'd workflow

Replace the action step with `louisescher/crabd@v1`. Prefer OIDC identity (`permissions: id-token:
write`) for the canonical bot, or App credentials. Keep the same event triggers, but note review fires
on `opened/reopened/ready_for_review` (not every push) — re-review via `@crabd review`.

Start from `workflows/github/crabd.yml` in the crab'd repo.

## 4. Translate config

Create `.crabd.yml`: set `model`, move custom instructions into `prompt.instructions`, port MCP
servers, and set limits. If staying on Claude, `model: anthropic/claude-sonnet-5` is the closest
match.

## 5. Secrets & cleanup

- Add the provider key secret (e.g. `ANTHROPIC_API_KEY`) to the repo.
- Set up identity (install the crab'd App, or App creds) — see the `add-crabd-to-repo` skill.
- Remove the old `claude-code-action` workflow and its now-unused secrets once crab'd works.

## 6. Verify

Trigger a mention and a PR; confirm crab'd reacts 👀, posts a tracking comment, and behaves like the
old setup.

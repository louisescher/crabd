---
title: Custom prompts
description: Shape how crab'd behaves — append house rules, tune per mode, or replace the prompt.
---

Every mode runs on a built-in **base prompt** (who crab'd is + what the mode should do). You shape
behavior by *appending* instructions to it, or, with governance permission, *replacing* it.

## Append instructions (the common case)

`prompt.instructions` is added to the base prompt. Use it for house rules that apply to every mode:

```yaml title=".crabd.yml"
prompt:
  instructions: |
    - Match the existing code style; don't reformat unrelated lines.
    - Prefer small, focused changes with clear commit messages.
    - Write British English in prose.
```

## Per-mode instructions

Each mode has its own `instructions`, added on top of the global ones, for guidance that only makes
sense for review, or only for implementation:

```yaml title=".crabd.yml"
modes:
  review:
    instructions: |
      - Flag missing tests for changed behavior.
      - Call out risky data migrations explicitly.
  implement:
    instructions: |
      - Add or update tests for anything you change.
```

## Instructions accumulate across layers

This is the key mental model: `instructions` (global and per-mode) **concatenate** across every
config layer, in precedence order: [org config](/configuration/#org-governance) → repo `.crabd.yml`
→ CI inputs. Nothing is overwritten.

So an org sets house rules once, and every repo inherits them and adds its own on top:

```yaml title="<owner>/.crabd-config/.crabd.yml (org)"
prompt:
  instructions: |
    - Never introduce a new dependency without noting why.
```
```yaml title=".crabd.yml (a repo)"
prompt:
  instructions: |
    - This service is latency-sensitive; avoid blocking calls.
```

The agent sees **both**.

## Steering a single run

You don't need config for one-off guidance. Anything after the mention is passed straight to the
agent, for any mode:

```text
@crabd Please review. Focus on the auth refactor, ignore the generated files.
```

See [Modes](/modes/) for how post-mention text maps to each mode.

## Replacing the base prompt (full override)

Sometimes you want to throw out the base prompt entirely. That's **off by default** and
**governance-gated**, because it lets a repo escape org house rules. Two things must both be true:

1. The org allowlists the repo:

   ```yaml title="<owner>/.crabd-config/.crabd.yml (org)"
   governance:
     full_override_repos: [acme/house-reviewer]
   ```

2. The repo opts in and supplies the replacement:

   ```yaml title=".crabd.yml (acme/house-reviewer)"
   prompt:
     allow_full_override: true
     override: |
       You are our house reviewer. Only comment on security and data-handling issues,
       and never request changes for style.
   ```

If the org hasn't listed the repo, `override` is ignored and the base prompt is used.

:::note
Full override replaces the base prompt, but `instructions` appends still apply on top. Org rules
you didn't intend to drop may still need to live in the override itself.
:::

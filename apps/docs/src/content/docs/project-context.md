---
title: Project context
description: How crab'd pulls your repo's own AGENTS.md / CLAUDE.md and skills into the run.
---

crab'd reads the context your repository already keeps for coding agents — its `AGENTS.md` /
`CLAUDE.md` instructions and its skills — and folds them into each run. The agent that answers a
mention, reviews a PR, or implements an issue then follows the **same conventions your local agents
do**, with no duplication into config.

Both are **on by default** and controlled by the [`context`](/reference/config-yaml/#context) config
section.

## Instruction files

crab'd loads `AGENTS.md`, then `CLAUDE.md`, from the checkout root and appends them to the system
prompt:

- **Both are honored.** `AGENTS.md` is the cross-tool convention; `CLAUDE.md` keeps parity for repos
  coming from `claude-code-action`. If both exist with the **same** content (a common symlink/copy),
  it's included once; if they differ, each is included under a labeled heading.
- **crab'd's own rules stay above them.** Project instructions are appended *after* the base prompt
  and your `prompt.instructions`, and the prompt states that core instructions win on conflict. This
  keeps a repo-authored file from silently overriding crab'd's guardrails.
- **Capped** at 40k characters combined, so a large file can't crowd out the diff and conversation.

Only the checkout **root** is read (not nested `AGENTS.md` files) — the agent can still open nested
files itself with its file tools while it works.

```yaml
# .crabd.yml — opt out if you'd rather steer purely from config
context:
  instruction_files: false
```

## Skills

crab'd discovers skills under `.agents/skills/` and `.claude/skills/`. For each skill it reads the
`name` and `description` from the `SKILL.md` frontmatter and lists them in the prompt:

```
## Available skills
- **run-tests** — Use when the user wants to run the suite. (`.claude/skills/run-tests/SKILL.md`)
```

This is **progressive disclosure**: only the one-line description is in the prompt. When a task
matches a skill, the agent reads that skill's `SKILL.md` itself (with its file tools) for the full
instructions — the body is never preloaded, so many skills cost almost no context.

- A skill in **both** roots is listed once (`.agents/skills` wins).
- A skill with **no description** is skipped — without one, the agent has no basis to pick it.

```yaml
context:
  skills: false
```

:::note
This is different from the [crab'd skills](/skills/) page, which lists **Claude Code skills for
humans building with crab'd** (`configure-crabd`, `add-crabd-to-repo`, …). Those help *you* in your
editor; the skills here are *your repo's* skills, surfaced to the crab'd agent at run time.
:::

## Layering

`context.instruction_files` and `context.skills` are booleans, so they follow the usual
[highest-layer-wins](/config-layering/) rule. An org can turn the whole behavior off for every repo
by setting them in the org config and locking the paths:

```yaml
# org .crabd.yml
context:
  skills: false
governance:
  locked: [context.skills]
```

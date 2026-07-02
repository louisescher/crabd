---
title: Skills
description: Claude Code skills for building with crab'd.
---

crab'd ships [Claude Code](https://claude.com/claude-code) **skills** — task-focused helpers you invoke
while working in your editor/agent. They live in the [`skills/`](https://github.com/louisescher/crabd/tree/main/skills)
directory of the repo.

## Install

Copy a skill into your project or user skills directory:

```bash
cp -r skills/configure-crabd ~/.claude/skills/     # user-wide
# or per project:
cp -r skills/configure-crabd .claude/skills/
```

Then invoke it, e.g. `/configure-crabd`.

## Available skills

| Skill | Use it to |
| --- | --- |
| `configure-crabd` | Write or fix `.crabd.yml` / `crabd.config.ts`, grounded in the live docs via `llms.txt`. |
| `add-crabd-to-repo` | Add the workflow, identity, secret, and a starter config to a repo. |
| `migrate-from-claude-code` | Convert a `claude-code-action` workflow to crab'd. |
| `write-custom-mode` | Scaffold a custom mode (schema + `finalize`) in `crabd.config.ts`. |
| `deploy-crabd-broker` | Deploy the token broker for the canonical `crab'd[bot]` identity. |

## llms.txt

The docs are also published for LLMs at **`/llms.txt`** (index), **`/llms-full.txt`** (everything in
one file), and **`/llms-small.txt`**. The `configure-crabd` skill fetches these so it always reasons
from current docs.

---
"@crabd/config": minor
"@crabd/core": minor
"@crabd/action": minor
---

Load repo-authored context into the run. crab'd now reads the repository's own `AGENTS.md` and
`CLAUDE.md` from the checkout root and appends them to the system prompt (after its base + configured
instructions, so core rules stay authoritative), and discovers skills under `.agents/skills/` and
`.claude/skills/` — listing each skill's name and description so the agent reads the matching
`SKILL.md` on demand (progressive disclosure). Both are on by default and configurable via the new
`context` config section (`context.instruction_files`, `context.skills`).

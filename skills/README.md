# crab'd Skills

Claude Code skills for building with crab'd. Each folder is a self-contained skill.

## Install

Copy the skill(s) you want into your project's (or user) skills directory:

```bash
cp -r skills/configure-crabd ~/.claude/skills/        # user-wide
# or, per project:
cp -r skills/configure-crabd .claude/skills/
```

Claude Code discovers them automatically; invoke with `/configure-crabd`, etc.

## Available skills

| Skill | Use it to |
| --- | --- |
| `configure-crabd` | Write or fix a `.crabd.yml` / `crabd.config.ts`, grounded in the live docs (`llms.txt`). |
| `add-crabd-to-repo` | Add the crab'd workflow, secrets, and App/identity to a GitHub or Forgejo repo. |
| `migrate-from-claude-code` | Convert a `claude-code-action` workflow to crab'd. |
| `write-custom-mode` | Scaffold a custom mode in `crabd.config.ts` (schema + finalize). |
| `deploy-crabd-broker` | Deploy the token broker for the canonical `crab'd[bot]` identity. |

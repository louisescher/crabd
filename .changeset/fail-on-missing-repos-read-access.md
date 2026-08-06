---
"@crabd/core": minor
"@crabd/action": minor
---

Fail the run when `repos.read` lists a repo crab'd cannot actually access, instead of continuing silently

Previously, if the GitHub App installation or Forgejo bot account didn't have access to a repo
listed in `repos.read` (for example, a repo in a second org the bot hadn't been added to), crab'd
would swallow the error and keep going: the agent's prompt still claimed `GH_TOKEN` access to that
repo, and the gap only surfaced when a `git`/`gh` call failed mid-run.

crab'd now preflights every explicit `repos.read` entry (skipped for `'all'` or a glob, since
neither is enumerable) before the run starts. If any repo is unreachable, the run fails immediately
with a tracking comment naming the repo and what to fix — add it to the App installation, add the
bot account as a member/collaborator, or remove it from `repos.read` — rather than continuing with a
token that doesn't cover what the agent was told it could reach.

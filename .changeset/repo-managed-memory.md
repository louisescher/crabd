---
"@crabd/config": minor
"@crabd/core": minor
---

Add repo-managed memory: reply to a crab'd comment to correct it, and it records what it learned as a markdown file under `.crabd/memory/`, read back into every future run. The files are plain markdown in your repository, so memories are reviewed in a pull request, edited, and deleted like any other file. Off by default via `memory.enabled`. Once enabled, `memory.write` chooses whether a recorded memory lands on the pull request branch (the default), in a dedicated pull request, or straight on the default branch.

Replying to an inline review finding now also carries the thread it answers. `getContext` fetched only the issue-level comment timeline, which never contains inline review comments, so a reply arrived with the correction but not the finding it was correcting, missing its path, line, and diff hunk. Both adapters now reconstruct the thread: GitHub from `in_reply_to_id`, Forgejo (which does not report reply ids) by grouping co-located comments on the same file and anchor.

crab'd's own inline findings carry a hidden marker so a later run can tell its own finding from a human's comment at the root of a thread. The bot's login varies by install, so the author field could not answer that.

Tracking comments can now carry run-scoped advisories, rendered below a rule above the footer and repeated on every state of the comment. Memory uses this to say up front, before the model starts, when recording is on but crab'd cannot write, rather than failing a commit after the work is done. In that case the tool is not offered to the model at all, so no write is attempted. A token whose scope cannot be introspected (a PAT or workflow token) is treated as unknown, never as "no access", so this raises no false warning.

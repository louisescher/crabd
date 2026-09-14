---
'@crabd/config': minor
'@crabd/core': minor
'@crabd/action': minor
---

Caps how many files one commit may carry, at `limits.max_commit_files` (default 200). The count comes from `git status` before any file is read, so an accidentally enormous working tree costs a refusal and nothing else. The message names the count and the first few paths, because a change this wide comes from a repo-wide formatter or a dependency install rather than from the task.

Uploads blobs eight at a time. A commit used to start every blob at once, which on a large change set opened thousands of simultaneous sockets, exhausted the process's file descriptors, and took the run down after every request had already failed.

Adds `limits.command_seconds` (default 300). flue's `bash` tool bounds a command only when the model asks it to, so a command the model gave no timeout ran unbounded. One run spent 272 seconds in a cold typecheck and 110 in a second one, better than half its wall clock. A command over the ceiling is killed and the model gets exit code 124 with a message naming the limit.

Tells the agent its budget. The tool-call ceiling, the wall clock, and the per-command limit go into the prompt with a wind-down instruction, so a run can ration what it has and stop on its own terms.

Exempts `submit` from the turn budget, and gives the wall-clock deadline the same wrap-up reserve the turn ceiling already had. A finished answer is no longer the tool call that gets cut off, and a run that runs out of time now reports what it has.

Leaves the commit contract off modes that commit nothing. A review run was told the harness would commit its edits and that `update_branch` was available, and neither is true for review.

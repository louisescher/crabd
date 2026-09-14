---
"@crabd/config": patch
"@crabd/core": patch
"@crabd/action": patch
---

Reads the whole repository config layer from the default branch on a pull request, and ignores the checkout's `.crabd.yml` there. Only `permissions`, `governance` and `prompt.override` moved before, which left the rest of the file contributor-controlled: `modes` picks which mode runs and what it is told, `prompt` and `review` rewrite the model's instructions, `sandbox.env` forwards named secrets into a shell the same file can steer, and `providers.custom` points the model call at an arbitrary endpoint. The visible symptom was smaller and more common: a repo that enabled `implement` on its default branch kept running in mention mode on every pull request opened before that line was added, because the head branch predates it.

Skips a `crabd.config.ts` extension on a pull request. The extension is loaded and executed in the process that holds crab'd's write-capable forge token, so a pull request head may not supply one for the run that reviews it.

Gives a mention on a pull request the open review conversation and the submitted reviews. A mention is routinely asked to act on a review, and until now it was not shown one: the threads were fetched only for an `implement` round. The model cannot fetch them either, so a run asked to address a finding spent six tool calls on forge API calls that answered 404, concluded the repository was private, grepped the checkout for the comment id, and then rebuilt the finding by reading the source tree.

Says what the sandbox credential can reach. It is minted `contents: read` and nothing else, and the forge answers a missing permission with `404` rather than `403`, so pull requests, issues, comments, reviews and CI runs all read as a repository that does not exist. The prompt now names the unreachable endpoints and points at the context that already holds the data, `gh pr` / `gh issue` / `gh run` and the matching `gh api` paths are refused in the sandbox with the same explanation, and `fetch_url` refuses the forge's own web pages.

Explains the detached HEAD in the workspace block. It is how crab'd checks out the commit under review, and an unlabelled `(detached HEAD)` read as damage: one run followed it with `git show-ref`, `git branch -a` and `git log` before doing any of the work it was asked for.

States the timeout and the truncation limit in the `web_search` and `fetch_url` descriptions, so the agent knows what a short answer means.

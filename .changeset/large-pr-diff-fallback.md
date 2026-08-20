---
"@crabd/core": patch
---

Review pull requests that touch more than 300 files, instead of failing the run.

GitHub refuses to serve the raw diff of a PR over 300 files: `GET /repos/{owner}/{repo}/pulls/{n}` with the diff media type answers `406`, code `too_large`. crab'd asked for that diff unconditionally, so every run on such a PR died in `getContext` before the agent started, with an unexplained `HttpError` as the only output. The diff is now rebuilt from the per-file patches that `pulls.listFiles` still returns, in the same `diff --git` plus `@@` shape prompt assembly and comment anchoring already parse, so review, anchoring, and verification work as before. An error that is not the size limit still fails the run.

`pulls.listFiles` is also paginated now, up to 1000 files. It was a single 100-item request, so on any PR touching more than 100 files the "Changed files" list quietly named the first 100 and the agent was told nothing about the rest.

The path lists in the prompt are capped at 200 entries, each with a count of what it left out. Three of them (the changed-file list, the diff's dropped-and-clipped notes, and the file contents skipped for budget) grew one line per file with no bound, which on a PR of this size is tens of thousands of characters of file names crowding out the diff itself.

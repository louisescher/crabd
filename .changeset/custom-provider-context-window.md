---
"@crabd/config": minor
"@crabd/action": minor
---

Add `context_window` and `max_tokens` to `providers.custom`, so self-hosted models the built-in catalog does not know get a real context window.

Without them a custom-provider model resolved with no metadata, and an unknown window is treated as zero. That capped every request at a single output token: the model emitted one reasoning token, never called a tool, and the turn failed after the framework's follow-up ceiling with nothing in the logs pointing at the cause. It also made context compaction fire on every turn. crab'd now warns at startup when a model runs on a custom provider with no `context_window`.

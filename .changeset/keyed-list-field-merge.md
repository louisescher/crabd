---
"@crabd/config": minor
---

Merge keyed config lists field by field instead of replacing whole entries. A layer that overrides one field of a `providers.custom` entry (by `id`) or an `mcp` entry (by `name`) now keeps the lower layer's remaining fields.

Previously a higher layer replaced the entry outright, so a CI layer injecting a provider's `base_url` silently dropped that entry's `api_key_env` and `context_window`. A dropped `context_window` capped every model response at a single output token, which surfaced as the agent emitting one reasoning token and never calling a tool.

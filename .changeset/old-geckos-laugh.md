---
"@crabd/action": minor
"@crabd/config": minor
"@crabd/core": minor
---

Adds rate limiting hanlder functionality and related settings.

When a model gets rate limited, users can now configure fallback models and the specific timeouts and how many retries crab'd should attempt. The bot identity will also update the persistent comment with relevant information. See the [rate limiting docs](https://crabd.lou.gg/reference/rate-limiting) for more info.

---
'@crabd/core': patch
'@crabd/action': patch
---

Use the workspace on disk when it holds the change under review, and stop narrating the prompt.

Built-in prompts also forbid writing about crab'd's own machinery, which is what produced review summaries opening with "As requested, because the checked-out workspace on disk does not include the changes under review, I have completed this review directly using the provided diff and line-numbered files from the prompt".

---
"@crabd/core": patch
---

Commits and memory writes now only include what changed during the run, never files that were already dirty or untracked in the checkout before it started. Fixes a leak where an ambient file written by an earlier CI step (a credentials file, say) could get swept into a commit.

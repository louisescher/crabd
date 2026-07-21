---
"@crabd/core": patch
---

Stop a single out-of-diff finding from sinking a whole review. GitHub (and Forgejo) reject the entire `createReview` call with `422 "Line could not be resolved"` when an inline comment points at a line outside the PR diff. Review mode now checks each finding's line against the actual diff hunks: in-diff findings post inline as before, and out-of-diff findings are folded into the review body as text instead of dropped. Both forge adapters also gained a last-resort fallback so a review always lands.

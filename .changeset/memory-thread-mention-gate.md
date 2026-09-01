---
"@crabd/core": patch
---

The memory gate no longer skips a review-comment reply just because the thread was started by a human rather than one of crab'd's own findings, as long as crab'd already has a tracking comment on the subject. That case previously left `remember` unmounted, so a direct "remember this" request got a confirmation in the reply text with no memory actually recorded.

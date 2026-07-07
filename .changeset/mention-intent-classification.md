---
"@crabd/core": minor
---

Route natural-language mentions to the right mode with a cheap intent classifier. Previously only
a mention that *started* with a mode keyword (`/crabd review`) reached review mode; a phrasing like
"@crabd please review again" fell back to `mention` and answered with a single free-text comment
instead of a real review.

Now, a bare mention (no mode keyword) is first classified by a low-thinking, no-tools model pass
(the new `crabd-classify` workflow) into one of the enabled modes, and crab'd runs that mode's full
turn.

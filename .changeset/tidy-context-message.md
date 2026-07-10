---
"@crabd/core": patch
---

Bound and deduplicate the free-text bodies in the assembled context message so a long PR description, a pasted log, or a big comment thread isn't re-sent on every turn of the agentic loop. The PR/issue body, the triggering comment, and each recent comment are now capped to a generous char budget, and the triggering comment is no longer duplicated when it also appears in the fetched comment list.

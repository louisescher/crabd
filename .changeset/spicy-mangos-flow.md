---
"@crabd/core": minor
"@crabd/config": minor
---

Send a compressed, high-signal PR diff by default — low-signal files (lockfiles, generated/minified/vendored output) are dropped, oversized files are clipped to the hunks that fit, and omissions are listed so the agent can read a file directly if needed. This cuts prompt size and exploration turns. The full diff is available via the new `context.full_diff` toggle (off by default).

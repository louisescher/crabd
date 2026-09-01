---
"@crabd/core": patch
---

Ignore comment webhook events with a `deleted` action. GitHub and Forgejo both still report the removed comment's body on that action, so a workflow subscribed to more than `created` could replay a mention that no longer exists.

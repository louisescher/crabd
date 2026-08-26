---
"@crabd/core": patch
---

Stop auto-reviewing draft pull requests.

A `pull_request` event only triggers `review` when the PR is not a draft. Opening or reopening a draft now does nothing, and the review runs when the PR is marked ready for review (`ready_for_review`) or opened as a regular PR. Mentions are unaffected: `/crabd review` in a draft still works, as does any other trigger phrase comment.

`ForgePullRequest` gained an `isDraft` flag, filled from the webhook payload and from the pull request API in both the GitHub and Forgejo adapters.

---
"@crabd/core": patch
---

Resolve Forgejo actor association via org membership before the permission endpoint. Reading another
user's repo permission (`/collaborators/{login}/permission`) requires the bot token to have
repo-admin, which is a heavy grant for a review bot. `resolveActor` now first checks org membership
(`GET /orgs/{owner}/members/{login}`), which any member-level token can read — an org member maps to
`MEMBER`. It only falls back to the permission endpoint for user-owned repos or non-member
collaborators. This lets a `write`-scoped bot authorize commenters without admin.

---
"@crabd/core": patch
---

Fix the Forgejo trust gate denying org owners. Forgejo/Gitea reports the permission
string `owner` for organization owners (GitHub never does — it uses `admin`), which
`permissionToAssociation` did not handle, so owners fell through to the `NONE`
association and were denied by `allowed_associations`. `owner` now maps to `OWNER`
alongside `admin`.

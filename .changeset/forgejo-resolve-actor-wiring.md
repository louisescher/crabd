---
"@crabd/core": patch
---

Actually resolve the Forgejo actor association before the trust gate. Forgejo/Gitea webhooks do
not carry `author_association`, so the parsed value was always `NONE` and every Forgejo actor was
denied — the `resolveActor` permission-lookup path existed but was never called. `prepareRun` now
calls `adapter.resolveActor` for Forgejo actors whose payload association is `NONE` (non-bots),
before authorizing, failing safe to `NONE` (denied) if the lookup errors. Combined with the
`owner` → `OWNER` mapping, Forgejo owners/collaborators can now trigger crab'd.

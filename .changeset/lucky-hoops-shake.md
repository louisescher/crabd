---
"@crabd/config": minor
"@crabd/broker": minor
"@crabd/action": minor
"@crabd/core": minor
---

Add read-only runs, and stop `mention` from committing unprompted

`permissions.write` is a new config key controlling whether crab'd may change the repository at
all. When it is off, `implement` stops triggering, `mention` answers without committing, and the
agent is told up front so it describes a change rather than writing one it cannot land.

It turns itself on in two cases:

- **`modes.implement.enabled: false`.** Disabling the only mode whose purpose is changing the repo
  now also closes the second, less obvious write path. Set `permissions.write: true` to keep
  mention's commits.
- **A token that cannot write.** crab'd asks its token which permissions it was granted and goes
  read-only when contents write is missing, instead of running the full turn and failing on a 403
  at the commit. Tokens with no introspectable scope (a PAT, the workflow `GITHUB_TOKEN`) are
  treated as unknown, not as read-only.

Separately, `mention` mode now commits only when the triggering comment actually asks for a change.
A bare mention or a question gets an answer; crab'd no longer decides on its own that a fix it
noticed is worth pushing to the branch.

Custom modes that write should declare `writes: 'required' | 'optional'` and pass
`writesAllowed: ctx.config.permissions.write` to `commitWorkingChanges`.

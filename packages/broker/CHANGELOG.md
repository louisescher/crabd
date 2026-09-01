# @crabd/broker

## 1.2.1

## 1.2.0

## 1.1.0

## 1.0.3

## 1.0.2

## 1.0.1

## 1.0.0

## 0.9.0

### Patch Changes

- d003ec0: Upgrade dependencies: js-yaml 5, jose 6, `@octokit/rest` 22, `@octokit/auth-app` 8, `@hono/node-server` 2, `@types/node` 26, TypeScript 7 (packages only), plus hono, vitest, tsdown, astro and starlight minors.

  js-yaml 5 drops its default export and now throws on a document with no content instead of returning nothing. `parseConfigYaml` keeps its documented contract: a `.crabd.yml` that is blank or all comments still resolves to an empty partial rather than failing the run.

## 0.8.0

## 0.7.0

### Minor Changes

- fd8a5f9: Add read-only runs, and stop `mention` from committing unprompted

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

## 0.6.1

## 0.6.0

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

## 0.4.1

## 0.4.0

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.0

## 0.1.1

## 0.1.0

### Minor Changes

- 800807e: Initial release

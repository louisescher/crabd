# @crabd/broker

## 1.3.0

### Patch Changes

- 189d9d7: Implement mode now works feedback rounds on a pull request, not just issues.

  On an issue it behaves as before: write the change, commit to a `crabd/...` branch, open a pull
  request. On a pull request it reads every unresolved review conversation, the submitted review
  bodies, and the failing checks on the head commit, commits one change onto that pull request's
  branch, and accounts for each conversation as fixed, already fixed, partly done, declined, answered,
  or needing clarification. On GitHub it replies inside each conversation and resolves the ones it
  fixed. Forgejo has no API for either, so a Forgejo round posts one summary comment instead.

  A round starts from a submitted review or an inline review comment on a pull request crab'd owns, or
  from `/crabd implement address the review` on any pull request it can write to. The two automatic
  triggers are GitHub-only, because Forgejo Actions has no review events to dispatch on. Ownership
  comes from a hidden marker crab'd now writes into the descriptions of the pull requests it opens,
  with the `crabd/` branch prefix as a fallback.

  New config, all optional: `implement.verify.commands` names the commands a run must execute and
  report (accumulated across layers, advisory rather than blocking), `implement.rounds` turns the
  automatic triggers and thread resolution on or off, and `implement.branch_prefix` sets the prefix.

  Three fixes came with it:

  - `mention` mode no longer commits on a fork pull request. Its head branch does not exist in the
    base repository, so the commit was creating a same-named branch off the default branch instead of
    amending the pull request.
  - `ForgejoForge.replyToReviewComment` was posting to an endpoint Forgejo does not have, and the
    request helper swallowed the 404, so every inline reply on Forgejo silently did nothing. Replies
    now go through a single-comment review anchored to the same line, and the helper only tolerates a
    404 on a GET.
  - `fromFork` was read from the head repository's own fork flag, which is true for a pull request
    raised inside a fork and false when the head repository is gone. It now compares the head and base
    repositories.

  One change needs action. The GitHub workflow template gains the review events, a `concurrency:`
  block, and `checks: read` / `actions: read`, so copy it over to pick them up. The broker asks for
  those two read permissions only when the installation already grants them, because GitHub rejects a
  token request for permissions it was never given. An installation that has not accepted them keeps
  working, and its rounds run without the CI section and say so.

  The `implement` mode's structured output gains a required `kind` field (`issue` or `round`), which
  is a breaking change for anything reading the action's `result` output for that mode.

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

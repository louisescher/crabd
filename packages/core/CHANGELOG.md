# @crabd/core

## 0.8.0

### Minor Changes

- 02c123a: Fail the run when `repos.read` lists a repo crab'd cannot actually access, instead of continuing silently

  Previously, if the GitHub App installation or Forgejo bot account didn't have access to a repo
  listed in `repos.read` (for example, a repo in a second org the bot hadn't been added to), crab'd
  would swallow the error and keep going: the agent's prompt still claimed `GH_TOKEN` access to that
  repo, and the gap only surfaced when a `git`/`gh` call failed mid-run.

  crab'd now preflights every explicit `repos.read` entry (skipped for `'all'` or a glob, since
  neither is enumerable) before the run starts. If any repo is unreachable, the run fails immediately
  with a tracking comment naming the repo and what to fix — add it to the App installation, add the
  bot account as a member/collaborator, or remove it from `repos.read` — rather than continuing with a
  token that doesn't cover what the agent was told it could reach.

### Patch Changes

- @crabd/config@0.8.0

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

### Patch Changes

- Updated dependencies [fd8a5f9]
  - @crabd/config@0.7.0

## 0.6.1

### Patch Changes

- b5aa409: Use the workspace on disk when it holds the change under review, and stop narrating the prompt.

  Built-in prompts also forbid writing about crab'd's own machinery, which is what produced review summaries opening with "As requested, because the checked-out workspace on disk does not include the changes under review, I have completed this review directly using the provided diff and line-numbered files from the prompt".
  - @crabd/config@0.6.1

## 0.6.0

### Minor Changes

- 44e591c: Substantially rework PR review to cut false positives and catch more real bugs.

  **Fixes a correctness bug first.** `pullRequest.headSha` was fetched but never used, and the shipped
  workflow templates checked out without an explicit `ref:`. On the `issue_comment` trigger — the main
  "@crabd review this" path — that left the runner on the base branch, so every file the agent opened
  was the wrong version while the diff in its prompt described the pull request. crab'd now compares
  the checkout against the PR head, moves onto it when it safely can (never touching a dirty tree), and
  otherwise tells the model outright that the files on disk are not the change under review. The
  workflow templates pass an explicit `ref:` for comment triggers.

  **The review prompt** grew from four lines into a structured one: the job is framed as finding where
  the change breaks rather than describing it, the model's own rationalisations are named and rebutted,
  and a phased method requires opening the real files and grepping for callers before judging anything.
  Findings must pass a refutation checklist (already handled / intentional / not actionable), and a
  built-in list of never-report classes and settled precedents replaces the previous lone strictness
  adjective. Reporting nothing is now explicitly a good outcome — the old level 3–5 guidance told the
  model to keep looking until it found something, which is an instruction to pad.

  **Findings are now checkable.** `ReviewOutputSchema` gains `severity`, `category`, `confidence`,
  `shortSummary`, `failureScenario`, `evidence`, and `recommendation` alongside the existing
  `path`/`line`/`body`, which are unchanged. `failureScenario` is required: a finding that cannot name
  concrete inputs _and_ the concrete wrong result cannot be serialised, which is exactly the shape a
  pattern-matched false positive takes. Gates then run in code, where the model cannot argue with them:
  sub-threshold findings are dropped, an `evidence.quote` that does not appear in the file it cites is
  discarded as a fabricated citation, findings are ranked by severity then confidence and capped, and
  crab'd will not approve while a blocking finding stands.

  **Anchoring is fixed.** The prompt now lists the exact lines a forge will accept an inline comment on
  and ships the changed files' line-numbered contents from HEAD, so the model copies coordinates
  instead of deriving them from a hunk header. A finding that still misses by a few lines is snapped
  onto the nearest legal line (noting the line it meant) rather than demoted to body text, and one that
  misses badly earns a bounded self-correction turn on the same session.

  **New config**, all under `review`: `min_confidence`, `max_findings`, and `dimensions` (each derived
  from `strictness` unless set), plus `exclusions` and `precedents`, which **accumulate** across config
  layers so an org can pin house rules and a repo can retire its own recurring false positives for
  good. `review.verify` adds an opt-in second pass that sends each candidate finding to an independent,
  blinded refuter and posts only what survives — the strongest lever on false positives, off by default
  because it costs an extra model call per finding.

### Patch Changes

- 3669e03: Run correctly when invoked from a Forgejo reusable workflow.
- Updated dependencies [44e591c]
  - @crabd/config@0.6.0

## 0.5.3

### Patch Changes

- 44babf0: Stop a single out-of-diff finding from sinking a whole review. GitHub (and Forgejo) reject the entire `createReview` call with `422 "Line could not be resolved"` when an inline comment points at a line outside the PR diff. Review mode now checks each finding's line against the actual diff hunks: in-diff findings post inline as before, and out-of-diff findings are folded into the review body as text instead of dropped. Both forge adapters also gained a last-resort fallback so a review always lands.
  - @crabd/config@0.5.3

## 0.5.2

### Patch Changes

- 0c2d220: Make private-registry auth failures cheap instead of budget-draining. When a `sandbox.npmrc` token can't be resolved, crab'd now warns loudly (a GitHub Actions annotation) **and** tells the agent, up front, which registries are unauthenticated so it reviews from source rather than burning its whole tool budget retrying `install`s that 401/403. It also fixes the "omit `token_env` for same-org GitHub Packages" fallback: the sandbox token is now minted with `packages: read` when a registry relies on the forge token (GitHub App strategy only — the hosted broker's tokens aren't packages-scoped, and crab'd now says so instead of silently failing).
  - @crabd/config@0.5.2

## 0.5.1

### Patch Changes

- aee9256: Bound and deduplicate the free-text bodies in the assembled context message so a long PR description, a pasted log, or a big comment thread isn't re-sent on every turn of the agentic loop. The PR/issue body, the triggering comment, and each recent comment are now capped to a generous char budget, and the triggering comment is no longer duplicated when it also appears in the fetched comment list.
  - @crabd/config@0.5.1

## 0.5.0

### Minor Changes

- 45aa43e: Send a compressed, high-signal PR diff by default — low-signal files (lockfiles, generated/minified/vendored output) are dropped, oversized files are clipped to the hunks that fit, and omissions are listed so the agent can read a file directly if needed. This cuts prompt size and exploration turns. The full diff is available via the new `context.full_diff` toggle (off by default).

### Patch Changes

- Updated dependencies [45aa43e]
  - @crabd/config@0.5.0

## 0.4.1

### Patch Changes

- 89c8761: Adds a way to increase how strict the reviewer is and adjusts the tone to be more neutral.
- Updated dependencies [89c8761]
  - @crabd/config@0.4.1

## 0.4.0

### Minor Changes

- 9750d6b: Route natural-language mentions to the right mode with a cheap intent classifier. Previously only
  a mention that _started_ with a mode keyword (`/crabd review`) reached review mode; a phrasing like
  "@crabd please review again" fell back to `mention` and answered with a single free-text comment
  instead of a real review.

  Now, a bare mention (no mode keyword) is first classified by a low-thinking, no-tools model pass
  (the new `crabd-classify` workflow) into one of the enabled modes, and crab'd runs that mode's full
  turn.

### Patch Changes

- ba15994: Resolve Forgejo actor association via org membership before the permission endpoint. Reading another
  user's repo permission (`/collaborators/{login}/permission`) requires the bot token to have
  repo-admin, which is a heavy grant for a review bot. `resolveActor` now first checks org membership
  (`GET /orgs/{owner}/members/{login}`), which any member-level token can read — an org member maps to
  `MEMBER`. It only falls back to the permission endpoint for user-owned repos or non-member
  collaborators. This lets a `write`-scoped bot authorize commenters without admin.
  - @crabd/config@0.4.0

## 0.3.2

### Patch Changes

- 15da1e5: Actually resolve the Forgejo actor association before the trust gate. Forgejo/Gitea webhooks do
  not carry `author_association`, so the parsed value was always `NONE` and every Forgejo actor was
  denied — the `resolveActor` permission-lookup path existed but was never called. `prepareRun` now
  calls `adapter.resolveActor` for Forgejo actors whose payload association is `NONE` (non-bots),
  before authorizing, failing safe to `NONE` (denied) if the lookup errors. Combined with the
  `owner` → `OWNER` mapping, Forgejo owners/collaborators can now trigger crab'd.
  - @crabd/config@0.3.2

## 0.3.1

### Patch Changes

- 374e77a: Fix the Forgejo trust gate denying org owners. Forgejo/Gitea reports the permission
  string `owner` for organization owners (GitHub never does — it uses `admin`), which
  `permissionToAssociation` did not handle, so owners fell through to the `NONE`
  association and were denied by `allowed_associations`. `owner` now maps to `OWNER`
  alongside `admin`.
  - @crabd/config@0.3.1

## 0.3.0

### Minor Changes

- 52da88b: Make crab'd's comment branding configurable. A new `appearance` config section sets the display
  name (`appearance.name`), the brand emoji prefixed to comments (`appearance.emoji` — set to `""` to
  remove it), and whether the `posted by` footer is shown (`appearance.footer`). Defaults reproduce the
  current look (`crab'd` / `🦀` / footer on). Status glyphs (⚠️/⏳/➡️) are unaffected, and the hidden
  tracking marker is always kept so sticky comment reuse still works even with the footer off.
- 7fbc83f: Config-driven cross-repo read access and private npm registries — no workflow changes.

  - **`repos.read`** (`'all'` or a list of `owner/repo`, globs allowed) lets the agent **read** other
    repositories. crab'd mints a **read-only, least-privilege** forge token scoped to what you allow and
    exposes it to the model's shell as `GH_TOKEN` (with `git` preconfigured), so it can `gh api` / `git
clone` those repos on demand — never write to them. Requires your own App (`CRABD_APP_*`), a scoped
    PAT, or (on Forgejo) a scoped `CRABD_FORGEJO_TOKEN`; the git credential and prompt guidance are
    forge-aware. The token broker stays single-repo by design (`repos.read` is ignored under it, with a
    log note).
  - **`sandbox.env` + `sandbox.npmrc`** authenticate `pnpm`/`npm install` against private registries:
    forward named CI-secret env vars into the shell, and write a managed `.npmrc` (via
    `NPM_CONFIG_USERCONFIG`, never clobbering the repo's own) whose auth lines reference tokens by
    env-var name — no secret literal touches config or disk. GitHub Packages in the same org can reuse
    the forge token.
  - Both sections are **governance-lockable** (`repos.read`, `sandbox.env`, `sandbox.npmrc`) so an org
    can forbid repos from self-granting cross-repo or secret access. The built-in prompt now reflects
    any granted cross-repo access. The action image adds the `gh` CLI.

- 3159c71: Helpful failure comments, a graceful landing at the turn limit, and a scoped-environment prompt.

  - **Every error crab'd posts is now actionable.** A new `renderFailure` replaces the raw
    code-fenced stack trace with a tailored comment per failure kind (`max_turns`, `timeout`,
    `config`, `network`, generic) — each explains what happened, names the exact config knob to
    change (e.g. `limits.max_turns`, `limits.timeout_minutes`), and links a new
    [Troubleshooting](https://crabd.lou.gg/troubleshooting/) page. The model turn returns fatal
    failures (max_turns, timeout, …) as structured results instead of throwing, and the hard-crash
    path no longer leaks the subprocess command line / serialized prompt into the comment.
  - **Graceful landing at the turn limit.** crab'd reserves a few turns near the ceiling to ask the
    model for a best-effort final answer, so a run that hits `limits.max_turns` posts a useful partial
    result (marked as partial) instead of aborting with no output. Fully best-effort — it degrades to
    the helpful max_turns comment if a wrap-up can't be produced.
  - **Scoped-environment prompt.** The built-in base prompts now tell the agent it works in a single,
    repository-scoped checkout, so it doesn't burn its budget looping on cross-repo files or CI it
    can't access. (Skipped when the prompt is fully overridden.)

- 245741e: Load repo-authored context into the run. crab'd now reads the repository's own `AGENTS.md` and
  `CLAUDE.md` from the checkout root and appends them to the system prompt (after its base + configured
  instructions, so core rules stay authoritative), and discovers skills under `.agents/skills/` and
  `.claude/skills/` — listing each skill's name and description so the agent reads the matching
  `SKILL.md` on demand (progressive disclosure). Both are on by default and configurable via the new
  `context` config section (`context.instruction_files`, `context.skills`).

### Patch Changes

- d51c64d: Adds support for AGENTS.md/CLAUDE.md as well as skills located in .agents/skills/ and .claude/skills/.
- Updated dependencies [52da88b]
- Updated dependencies [7fbc83f]
- Updated dependencies [245741e]
- Updated dependencies [d51c64d]
  - @crabd/config@0.3.0

## 0.2.0

### Minor Changes

- a965d53: Adds rate limiting hanlder functionality and related settings.

  When a model gets rate limited, users can now configure fallback models and the specific timeouts and how many retries crab'd should attempt. The bot identity will also update the persistent comment with relevant information. See the [rate limiting docs](https://crabd.lou.gg/reference/rate-limiting) for more info.

### Patch Changes

- Updated dependencies [a965d53]
  - @crabd/config@0.2.0

## 0.1.1

### Patch Changes

- 85296a0: Adds websearch and improves review output labeling
- Updated dependencies [85296a0]
  - @crabd/config@0.1.1

## 0.1.0

### Minor Changes

- 800807e: Initial release

### Patch Changes

- Updated dependencies [800807e]
  - @crabd/config@0.1.0

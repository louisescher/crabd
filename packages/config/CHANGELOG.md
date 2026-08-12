# @crabd/config

## 1.0.0

### Minor Changes

- bd01e16: Migrate to Flue 2 and run the agent in-process.

  Flue 2 removes `defineWorkflow`, `defineAgent`'s config bag, `flue build`, and the auto-mounted router, so crab'd's two workflows are now agent functions (`src/agents/`) driven by `start()` plus `init()/dispatch()/read()` from the CLI itself. The `flue run` subprocess, its stdout JSON protocol with a 64 MB buffer, `app.ts`, `flue.config.ts`, and the `@flue/cli` dependency are all gone; the image builds one tsdown bundle.

  Orchestration that used to live inside the workflow body now lives in `src/turn-runner.ts`, because an agent in v2 is one addressable conversation: the rate-limit fallback chain opens a fresh instance per attempt (preserving the clean-context retry that `harness.session()` gave), the repair pass dispatches to the same instance so it keeps what it read, and the verify stage addresses one refuter instance per finding instead of delegating. v2 delegation is model-driven through the `task` tool, which could not have kept that fan-out deterministic.

  Two guarantees the framework used to provide are now explicit: the turn budget (v2 enforces no step cap) counts tool starts and stops applying once the wrap-up is in flight, so a run that exhausts its budget still returns a partial answer; and the mode's output schema is enforced by a terminal `submit` tool with a stated directive and a bounded nudge, replacing the `result` option's built-in re-prompt loop.

  Custom providers are now real pi-ai providers built from config rather than flue registrations, which is what makes the new `providers.custom[].reasoning` and `providers.custom[].vision` fields possible — flue's registration surface could not express either at any version, so a self-hosted reasoning model silently received no thinking controls and images sent to a self-hosted vision model were silently replaced with an `(image omitted)` placeholder.

  The rate-limit fallback chain needed rescuing: `handle.read()` rejects with an `AgentRunError` carrying only `{ outcome, submissionId }`, so classifying the rejection saw no status code, called every rate limit fatal, and never switched models. The provider's status is captured from the runtime event stream instead (`operation` and `submission_settled` carry it; a failed `turn` event reports `isError` with a null `error`).

  Per-run configuration is passed as values through a run context instead of ~20 `CRABD_*` env vars, which only existed to cross the process boundary.

  `providers.custom[].base_url` is now optional per layer (a higher layer can override one field), and `resolveConfig` throws when no layer supplied one.

- bd01e16: Merge keyed config lists field by field instead of replacing whole entries. A layer that overrides one field of a `providers.custom` entry (by `id`) or an `mcp` entry (by `name`) now keeps the lower layer's remaining fields.

  Previously a higher layer replaced the entry outright, so a CI layer injecting a provider's `base_url` silently dropped that entry's `api_key_env` and `context_window`. A dropped `context_window` capped every model response at a single output token, which surfaced as the agent emitting one reasoning token and never calling a tool.

- a19a41d: Add repo-managed memory: reply to a crab'd comment to correct it, and it records what it learned as a markdown file under `.crabd/memory/`, read back into every future run. The files are plain markdown in your repository, so memories are reviewed in a pull request, edited, and deleted like any other file. Off by default via `memory.enabled`. Once enabled, `memory.write` chooses whether a recorded memory lands on the pull request branch (the default), in a dedicated pull request, or straight on the default branch.

  Replying to an inline review finding now also carries the thread it answers. `getContext` fetched only the issue-level comment timeline, which never contains inline review comments, so a reply arrived with the correction but not the finding it was correcting, missing its path, line, and diff hunk. Both adapters now reconstruct the thread: GitHub from `in_reply_to_id`, Forgejo (which does not report reply ids) by grouping co-located comments on the same file and anchor.

  crab'd's own inline findings carry a hidden marker so a later run can tell its own finding from a human's comment at the root of a thread. The bot's login varies by install, so the author field could not answer that.

  Tracking comments can now carry run-scoped advisories, rendered below a rule above the footer and repeated on every state of the comment. Memory uses this to say up front, before the model starts, when recording is on but crab'd cannot write, rather than failing a commit after the work is done. In that case the tool is not offered to the model at all, so no write is attempted. A token whose scope cannot be introspected (a PAT or workflow token) is treated as unknown, never as "no access", so this raises no false warning.

## 0.9.0

### Minor Changes

- d003ec0: Add `context_window` and `max_tokens` to `providers.custom`, so self-hosted models the built-in catalog does not know get a real context window.

  Without them a custom-provider model resolved with no metadata, and an unknown window is treated as zero. That capped every request at a single output token: the model emitted one reasoning token, never called a tool, and the turn failed after the framework's follow-up ceiling with nothing in the logs pointing at the cause. It also made context compaction fire on every turn. crab'd now warns at startup when a model runs on a custom provider with no `context_window`.

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

## 0.5.3

## 0.5.2

## 0.5.1

## 0.5.0

### Minor Changes

- 45aa43e: Send a compressed, high-signal PR diff by default — low-signal files (lockfiles, generated/minified/vendored output) are dropped, oversized files are clipped to the hunks that fit, and omissions are listed so the agent can read a file directly if needed. This cuts prompt size and exploration turns. The full diff is available via the new `context.full_diff` toggle (off by default).

## 0.4.1

### Patch Changes

- 89c8761: Adds a way to increase how strict the reviewer is and adjusts the tone to be more neutral.

## 0.4.0

## 0.3.2

## 0.3.1

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

- 245741e: Load repo-authored context into the run. crab'd now reads the repository's own `AGENTS.md` and
  `CLAUDE.md` from the checkout root and appends them to the system prompt (after its base + configured
  instructions, so core rules stay authoritative), and discovers skills under `.agents/skills/` and
  `.claude/skills/` — listing each skill's name and description so the agent reads the matching
  `SKILL.md` on demand (progressive disclosure). Both are on by default and configurable via the new
  `context` config section (`context.instruction_files`, `context.skills`).

### Patch Changes

- d51c64d: Adds support for AGENTS.md/CLAUDE.md as well as skills located in .agents/skills/ and .claude/skills/.

## 0.2.0

### Minor Changes

- a965d53: Adds rate limiting hanlder functionality and related settings.

  When a model gets rate limited, users can now configure fallback models and the specific timeouts and how many retries crab'd should attempt. The bot identity will also update the persistent comment with relevant information. See the [rate limiting docs](https://crabd.lou.gg/reference/rate-limiting) for more info.

## 0.1.1

### Patch Changes

- 85296a0: Adds websearch and improves review output labeling

## 0.1.0

### Minor Changes

- 800807e: Initial release

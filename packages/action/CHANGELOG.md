# @crabd/action

## 1.7.0

### Patch Changes

- Updated dependencies [d26ea38]
  - @crabd/core@1.7.0
  - @crabd/config@1.7.0

## 1.6.1

### Patch Changes

- 3e19022: Reads the whole repository config layer from the default branch on a pull request, and ignores the checkout's `.crabd.yml` there. Only `permissions`, `governance` and `prompt.override` moved before, which left the rest of the file contributor-controlled: `modes` picks which mode runs and what it is told, `prompt` and `review` rewrite the model's instructions, `sandbox.env` forwards named secrets into a shell the same file can steer, and `providers.custom` points the model call at an arbitrary endpoint. The visible symptom was smaller and more common: a repo that enabled `implement` on its default branch kept running in mention mode on every pull request opened before that line was added, because the head branch predates it.

  Skips a `crabd.config.ts` extension on a pull request. The extension is loaded and executed in the process that holds crab'd's write-capable forge token, so a pull request head may not supply one for the run that reviews it.

  Gives a mention on a pull request the open review conversation and the submitted reviews. A mention is routinely asked to act on a review, and until now it was not shown one: the threads were fetched only for an `implement` round. The model cannot fetch them either, so a run asked to address a finding spent six tool calls on forge API calls that answered 404, concluded the repository was private, grepped the checkout for the comment id, and then rebuilt the finding by reading the source tree.

  Says what the sandbox credential can reach. It is minted `contents: read` and nothing else, and the forge answers a missing permission with `404` rather than `403`, so pull requests, issues, comments, reviews and CI runs all read as a repository that does not exist. The prompt now names the unreachable endpoints and points at the context that already holds the data, `gh pr` / `gh issue` / `gh run` and the matching `gh api` paths are refused in the sandbox with the same explanation, and `fetch_url` refuses the forge's own web pages.

  Explains the detached HEAD in the workspace block. It is how crab'd checks out the commit under review, and an unlabelled `(detached HEAD)` read as damage: one run followed it with `git show-ref`, `git branch -a` and `git log` before doing any of the work it was asked for.

  States the timeout and the truncation limit in the `web_search` and `fetch_url` descriptions, so the agent knows what a short answer means.

- Updated dependencies [3e19022]
  - @crabd/config@1.6.1
  - @crabd/core@1.6.1

## 1.6.0

### Minor Changes

- 0b26f38: Caps how many files one commit may carry, at `limits.max_commit_files` (default 200). The count comes from `git status` before any file is read, so an accidentally enormous working tree costs a refusal and nothing else. The message names the count and the first few paths, because a change this wide comes from a repo-wide formatter or a dependency install rather than from the task.

  Uploads blobs eight at a time. A commit used to start every blob at once, which on a large change set opened thousands of simultaneous sockets, exhausted the process's file descriptors, and took the run down after every request had already failed.

  Adds `limits.command_seconds` (default 300). flue's `bash` tool bounds a command only when the model asks it to, so a command the model gave no timeout ran unbounded. One run spent 272 seconds in a cold typecheck and 110 in a second one, better than half its wall clock. A command over the ceiling is killed and the model gets exit code 124 with a message naming the limit.

  Tells the agent its budget. The tool-call ceiling, the wall clock, and the per-command limit go into the prompt with a wind-down instruction, so a run can ration what it has and stop on its own terms.

  Exempts `submit` from the turn budget, and gives the wall-clock deadline the same wrap-up reserve the turn ceiling already had. A finished answer is no longer the tool call that gets cut off, and a run that runs out of time now reports what it has.

  Leaves the commit contract off modes that commit nothing. A review run was told the harness would commit its edits and that `update_branch` was available, and neither is true for review.

### Patch Changes

- Updated dependencies [0b26f38]
  - @crabd/config@1.6.0
  - @crabd/core@1.6.0

## 1.5.0

### Minor Changes

- 9fbeaf8: Improves what a run's log tells you. Every `bash` call logs the command it ran, every file tool logs the path it touched, and the model's reasoning goes into a collapsed group under the turn it belongs to. The full argument object stays behind `CRABD_VERBOSE`, where file contents belong.

  Adds a reporter on its own thread. A heap that climbs to the V8 ceiling inside one synchronous step blocks the event loop, which is where the in-process watchdog lives, so the log used to end on whatever line came before the crash. The reporter writes through that window and names the memory in use and the tool call that was running.

  Adds a node diagnostic report to the container, read by the post step. A run that aborts is reported as out of memory, with the heap in use and the ceiling it hit, in both the log and the tracking comment. Set `CRABD_REPORT_DIR` to move the file.

  Adds a comment when a run dies. Editing the tracking comment notifies nobody, so a crash or a cancel now also leaves a short comment addressed to whoever triggered the run: a threaded reply when an inline review comment set it off, a comment on the pull request otherwise.

  Changes the default heap ceiling to 6144 MB, and stops the container writing a core dump. A multi-gigabyte core kept one crashed job running for two and a half minutes after it had already died.

### Patch Changes

- Updated dependencies [9fbeaf8]
  - @crabd/core@1.5.0
  - @crabd/config@1.5.0

## 1.4.0

### Minor Changes

- db1d86b: Adds `update_branch`, the supported way to bring a pull request's branch up to date with its base. It merges on the forge under crab'd's identity, and stops on a conflict for a human to sort out. Available on `mention` and `implement` runs on a pull request crab'd can write to.

  Changes the agent's sandbox so `git` cannot write to the repository, and removes the credentials `actions/checkout` leaves in `.git/config` before the turn starts. Every commit goes through the forge API, where the secret scan and the branch-moved guard run.

  Adds a scope rule to `mention`. The comment that triggered the run is the instruction. The pull request body, other comments, and review threads are context.

  Fixes a run that crashes or is cancelled leaving its tracking comment on "is working" forever. A post step now posts the failure.

  Fixes `limits.timeout_minutes`, which was parsed and never enforced. It defaults to `20` and bounds the whole run, retries and fallback-model switches included. Set it to `0` for no ceiling.

  Improves what a run tells you. The rate-limited comment names the model, the attempt and the wait, every comment links the run logs, and tool and turn events log without `CRABD_VERBOSE`.

  #### Two things to update

  Copy `timeout-minutes: 30` from the workflow template into your own workflow, as a backstop above `limits.timeout_minutes`.

  If a later step in the same job pushed using the checkout's credentials, give it its own: re-run `actions/checkout`, or pass a token explicitly.

- db1d86b: Fixes a `.crabd.yml` on a pull request head being able to set the permissions of the run reviewing it. `permissions.*`, `governance.*` and `prompt.override` are read from the repository's default branch. Everything else, `implement.verify.commands` included, still comes from the checkout. A permissions change on the default branch now applies to pull requests that are already open.

  Fixes Vertex rate limits reported as `RESOURCE_EXHAUSTED` being treated as fatal, which meant `rate_limit.fallback_models` never engaged.

  Improves what a failed secret scan tells you. A scan that times out is retried once, then reported as a timeout with the file count and the limit. A missing gitleaks binary is reported as a packaging problem. The default timeout is 120 seconds, and the commit is refused in both cases.

### Patch Changes

- Updated dependencies [db1d86b]
- Updated dependencies [db1d86b]
  - @crabd/core@1.4.0
  - @crabd/config@1.4.0

## 1.3.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [f06c9ac]
- Updated dependencies [189d9d7]
  - @crabd/core@1.3.0
  - @crabd/config@1.3.0

## 1.2.1

### Patch Changes

- Updated dependencies [d7af570]
  - @crabd/core@1.2.1
  - @crabd/config@1.2.1

## 1.2.0

### Minor Changes

- 3812e05: Scan every commit and memory write for secrets with gitleaks before it reaches the forge, blocking the write on a finding. New `permissions.secret_scan` config field, on by default.
- 3812e05: Add `CRABD_VERBOSE`/`CRABD_DEBUG` for per-tool-call, per-turn, and task/compaction logs that were previously dropped entirely.

### Patch Changes

- 3812e05: The `remember` tool now checks existing memories before writing and states the specific correction instead of a generic paraphrase, and a memory-eligible reply gets the same surrounding file content review mode already sends.
- Updated dependencies [3812e05]
- Updated dependencies [3812e05]
- Updated dependencies [3812e05]
- Updated dependencies [3812e05]
- Updated dependencies [3812e05]
- Updated dependencies [3812e05]
  - @crabd/core@1.2.0
  - @crabd/config@1.2.0

## 1.1.0

### Minor Changes

- c4f297c: Report a run that runs out of memory instead of letting the process crash silently.

  A turn's own context and tool output can grow without bound between tool calls, so the existing `limits.max_turns` ceiling never catches it: a runaway turn could climb straight to a V8 out-of-memory crash, which kills the process outright rather than rejecting a promise. That left the tracking comment stuck on "working..." forever, with nothing in the log beyond V8's own stack dump. A watchdog now samples heap usage while a turn runs and aborts the attempt itself well before the crash, reporting a new `resource_exhausted` failure kind with a tailored comment instead.

  The `remember` tool now logs every memory it records or fails to record, by name and size, so a run that touches memory leaves an actual trail of what happened.

  Recorded memories get their own tracking comment instead of riding along on the pinned one. A memory note used to be folded into the same comment as the mode's actual answer, competing for space and resetting on every run. It now posts to (and updates) a dedicated sticky comment, found by its own hidden marker, so a later run's memory note updates in place rather than piling onto the main result.

### Patch Changes

- Updated dependencies [c4f297c]
  - @crabd/core@1.1.0
  - @crabd/config@1.1.0

## 1.0.3

### Patch Changes

- Updated dependencies [0ff71c8]
  - @crabd/core@1.0.3
  - @crabd/config@1.0.3

## 1.0.2

### Patch Changes

- Updated dependencies [bf99790]
  - @crabd/core@1.0.2
  - @crabd/config@1.0.2

## 1.0.1

### Patch Changes

- c03851d: Re-run a turn whose harness lost the conversation, instead of throwing the finished work away.

  When a model call fails transiently, Flue retries it by resuming the conversation it already has. If that conversation's tail projects to an assistant message, pi-agent-core's `continue()` refuses to resume and rejects with `Cannot continue from message role: assistant`. crab'd read that as a fatal error, so it skipped the fallback chain entirely and failed the check, discarding a review that was minutes of work and seconds from being submitted. Such a failure is now retried once on a fresh instance, which starts from an empty conversation and so cannot inherit the tail that caused it. A deliberate `max_turns` abort is untouched: it must not buy a second full turn.

  A transient model retry now also records the provider's own error. Flue reports the failure it is retrying on the log event's attributes and prints only the message, so a run's entire account of why the model failed was the words "Retrying transient model error". Beyond leaving the run undiagnosable, it also cost the fallback chain the one string it could have classified when the retry then failed opaquely.
  - @crabd/config@1.0.1
  - @crabd/core@1.0.1

## 1.0.0

### Major Changes

- bd01e16: Migrate to Flue 2 and run the agent in-process.

  Flue 2 removes `defineWorkflow`, `defineAgent`'s config bag, `flue build`, and the auto-mounted router, so crab'd's two workflows are now agent functions (`src/agents/`) driven by `start()` plus `init()/dispatch()/read()` from the CLI itself. The `flue run` subprocess, its stdout JSON protocol with a 64 MB buffer, `app.ts`, `flue.config.ts`, and the `@flue/cli` dependency are all gone; the image builds one tsdown bundle.

  Orchestration that used to live inside the workflow body now lives in `src/turn-runner.ts`, because an agent in v2 is one addressable conversation: the rate-limit fallback chain opens a fresh instance per attempt (preserving the clean-context retry that `harness.session()` gave), the repair pass dispatches to the same instance so it keeps what it read, and the verify stage addresses one refuter instance per finding instead of delegating. v2 delegation is model-driven through the `task` tool, which could not have kept that fan-out deterministic.

  Two guarantees the framework used to provide are now explicit: the turn budget (v2 enforces no step cap) counts tool starts and stops applying once the wrap-up is in flight, so a run that exhausts its budget still returns a partial answer; and the mode's output schema is enforced by a terminal `submit` tool with a stated directive and a bounded nudge, replacing the `result` option's built-in re-prompt loop.

  Custom providers are now real pi-ai providers built from config rather than flue registrations, which is what makes the new `providers.custom[].reasoning` and `providers.custom[].vision` fields possible — flue's registration surface could not express either at any version, so a self-hosted reasoning model silently received no thinking controls and images sent to a self-hosted vision model were silently replaced with an `(image omitted)` placeholder.

  The rate-limit fallback chain needed rescuing: `handle.read()` rejects with an `AgentRunError` carrying only `{ outcome, submissionId }`, so classifying the rejection saw no status code, called every rate limit fatal, and never switched models. The provider's status is captured from the runtime event stream instead (`operation` and `submission_settled` carry it; a failed `turn` event reports `isError` with a null `error`).

  Per-run configuration is passed as values through a run context instead of ~20 `CRABD_*` env vars, which only existed to cross the process boundary.

  `providers.custom[].base_url` is now optional per layer (a higher layer can override one field), and `resolveConfig` throws when no layer supplied one.

### Patch Changes

- Updated dependencies [bd01e16]
- Updated dependencies [bd01e16]
- Updated dependencies [a19a41d]
  - @crabd/config@1.0.0
  - @crabd/core@1.0.0

## 0.9.0

### Minor Changes

- d003ec0: Add `context_window` and `max_tokens` to `providers.custom`, so self-hosted models the built-in catalog does not know get a real context window.

  Without them a custom-provider model resolved with no metadata, and an unknown window is treated as zero. That capped every request at a single output token: the model emitted one reasoning token, never called a tool, and the turn failed after the framework's follow-up ceiling with nothing in the logs pointing at the cause. It also made context compaction fire on every turn. crab'd now warns at startup when a model runs on a custom provider with no `context_window`.

### Patch Changes

- d003ec0: Upgrade dependencies: js-yaml 5, jose 6, `@octokit/rest` 22, `@octokit/auth-app` 8, `@hono/node-server` 2, `@types/node` 26, TypeScript 7 (packages only), plus hono, vitest, tsdown, astro and starlight minors.

  js-yaml 5 drops its default export and now throws on a document with no content instead of returning nothing. `parseConfigYaml` keeps its documented contract: a `.crabd.yml` that is blank or all comments still resolves to an empty partial rather than failing the run.

- Updated dependencies [d003ec0]
- Updated dependencies [d003ec0]
  - @crabd/config@0.9.0
  - @crabd/core@0.9.0

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

- Updated dependencies [02c123a]
  - @crabd/core@0.8.0
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
  - @crabd/core@0.7.0

## 0.6.1

### Patch Changes

- b5aa409: Use the workspace on disk when it holds the change under review, and stop narrating the prompt.

  Built-in prompts also forbid writing about crab'd's own machinery, which is what produced review summaries opening with "As requested, because the checked-out workspace on disk does not include the changes under review, I have completed this review directly using the provided diff and line-numbered files from the prompt".

- Updated dependencies [b5aa409]
  - @crabd/core@0.6.1
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

- Updated dependencies [3669e03]
- Updated dependencies [44e591c]
  - @crabd/core@0.6.0
  - @crabd/config@0.6.0

## 0.5.3

### Patch Changes

- Updated dependencies [44babf0]
  - @crabd/core@0.5.3
  - @crabd/config@0.5.3

## 0.5.2

### Patch Changes

- 0c2d220: Make private-registry auth failures cheap instead of budget-draining. When a `sandbox.npmrc` token can't be resolved, crab'd now warns loudly (a GitHub Actions annotation) **and** tells the agent, up front, which registries are unauthenticated so it reviews from source rather than burning its whole tool budget retrying `install`s that 401/403. It also fixes the "omit `token_env` for same-org GitHub Packages" fallback: the sandbox token is now minted with `packages: read` when a registry relies on the forge token (GitHub App strategy only — the hosted broker's tokens aren't packages-scoped, and crab'd now says so instead of silently failing).
- Updated dependencies [0c2d220]
  - @crabd/core@0.5.2
  - @crabd/config@0.5.2

## 0.5.1

### Patch Changes

- Updated dependencies [aee9256]
  - @crabd/core@0.5.1
  - @crabd/config@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [45aa43e]
  - @crabd/core@0.5.0
  - @crabd/config@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [89c8761]
  - @crabd/config@0.4.1
  - @crabd/core@0.4.1

## 0.4.0

### Patch Changes

- Updated dependencies [ba15994]
- Updated dependencies [9750d6b]
  - @crabd/core@0.4.0
  - @crabd/config@0.4.0

## 0.3.2

### Patch Changes

- Updated dependencies [15da1e5]
  - @crabd/core@0.3.2
  - @crabd/config@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [374e77a]
  - @crabd/core@0.3.1
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
- Updated dependencies [3159c71]
- Updated dependencies [245741e]
- Updated dependencies [d51c64d]
  - @crabd/config@0.3.0
  - @crabd/core@0.3.0

## 0.2.0

### Minor Changes

- a965d53: Adds rate limiting hanlder functionality and related settings.

  When a model gets rate limited, users can now configure fallback models and the specific timeouts and how many retries crab'd should attempt. The bot identity will also update the persistent comment with relevant information. See the [rate limiting docs](https://crabd.lou.gg/reference/rate-limiting) for more info.

### Patch Changes

- Updated dependencies [a965d53]
  - @crabd/config@0.2.0
  - @crabd/core@0.2.0

## 0.1.1

### Patch Changes

- 85296a0: Adds websearch and improves review output labeling
- Updated dependencies [85296a0]
  - @crabd/config@0.1.1
  - @crabd/core@0.1.1

## 0.1.0

### Minor Changes

- 800807e: Initial release

### Patch Changes

- Updated dependencies [800807e]
  - @crabd/config@0.1.0
  - @crabd/core@0.1.0

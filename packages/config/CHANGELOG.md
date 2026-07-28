# @crabd/config

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

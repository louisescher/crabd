# @crabd/action

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

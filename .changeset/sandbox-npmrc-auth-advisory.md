---
"@crabd/core": patch
"@crabd/action": patch
---

Make private-registry auth failures cheap instead of budget-draining. When a `sandbox.npmrc` token can't be resolved, crab'd now warns loudly (a GitHub Actions annotation) **and** tells the agent, up front, which registries are unauthenticated so it reviews from source rather than burning its whole tool budget retrying `install`s that 401/403. It also fixes the "omit `token_env` for same-org GitHub Packages" fallback: the sandbox token is now minted with `packages: read` when a registry relies on the forge token (GitHub App strategy only — the hosted broker's tokens aren't packages-scoped, and crab'd now says so instead of silently failing).

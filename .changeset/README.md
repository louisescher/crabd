# Changesets

This folder holds [changesets](https://github.com/changesets/changesets) — one markdown file per
pending change, describing what changed and the semver bump.

## Add one

```bash
pnpm changeset
```

Pick the bump (patch/minor/major) and write a short summary. All `@crabd/*` packages are **fixed**, so
they version together as a single product version — that version becomes the crab'd Docker image tag.

## How a release happens

1. You merge PRs that include changesets.
2. The Release workflow opens/updates a **"Version Packages"** PR that consumes the changesets:
   bumps versions and updates `CHANGELOG.md`.
3. Merging that PR builds and publishes the action image (`ghcr.io/louisescher/crabd:vX.Y.Z`, `:vX`,
   `:latest`), tags the commit `vX.Y.Z`, and cuts a GitHub release.

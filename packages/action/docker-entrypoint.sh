#!/bin/sh
set -e

# The Actions runner mounts the repo at /github/workspace, owned by a different uid
# than this container's root — tell git it's safe so crab'd can inspect/commit it.
git config --global --add safe.directory "${GITHUB_WORKSPACE:-/github/workspace}" || true

exec node /app/packages/action/dist/cli.mjs

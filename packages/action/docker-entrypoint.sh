#!/bin/sh
set -e

# The Actions runner mounts the repo at /github/workspace, owned by a different uid
# than this container's root — tell git it's safe so crab'd can inspect/commit it.
git config --global --add safe.directory "${GITHUB_WORKSPACE:-/github/workspace}" || true

# Set here rather than NODE_OPTIONS, which every process the agent's shell spawns would inherit.
exec node --max-old-space-size="${CRABD_MAX_OLD_SPACE_MB:-3072}" /app/packages/action/dist/cli.mjs

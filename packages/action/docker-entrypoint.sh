#!/bin/sh
set -e

# The Actions runner mounts the repo at /github/workspace, owned by a different uid
# than this container's root — tell git it's safe so crab'd can inspect/commit it.
git config --global --add safe.directory "${GITHUB_WORKSPACE:-/github/workspace}" || true

# A V8 abort raises SIGABRT, and the host writes the core. Dumping a multi-gigabyte heap through the
# host's core handler is what kept run 34819067005 alive for two and a half minutes after it had
# already died. The diagnostic report below is what a crash is read from.
ulimit -c 0 2>/dev/null || true

# Both this container and the post container mount the runner's temp directory at the same path,
# which is what lets the post step read a report written by a process that is already gone.
if [ -n "${CRABD_REPORT_DIR:-}" ]; then
  REPORT_DIR="${CRABD_REPORT_DIR}"
elif [ -d /github/runner_temp ]; then
  REPORT_DIR=/github/runner_temp
elif [ -n "${RUNNER_TEMP:-}" ] && [ -d "${RUNNER_TEMP}" ]; then
  REPORT_DIR="${RUNNER_TEMP}"
else
  REPORT_DIR=/tmp
fi
export CRABD_REPORT_DIR="${REPORT_DIR}"

# Set on this invocation. NODE_OPTIONS would reach every process the agent's shell spawns too.
exec node \
  --max-old-space-size="${CRABD_MAX_OLD_SPACE_MB:-6144}" \
  --report-on-fatalerror \
  --report-directory="${REPORT_DIR}" \
  /app/packages/action/dist/cli.mjs

#!/bin/sh
# The action's post step. It reports a run that ended without reporting itself: a heap crash, or a
# cancelled job. A failure here must never fail the job, hence the unconditional exit 0.
node /app/packages/action/dist/post.mjs || true
exit 0

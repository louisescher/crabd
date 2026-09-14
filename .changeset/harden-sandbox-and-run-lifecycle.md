---
'@crabd/core': minor
'@crabd/config': minor
'@crabd/action': minor
---

Adds `update_branch`, the supported way to bring a pull request's branch up to date with its base. It merges on the forge under crab'd's identity, and stops on a conflict for a human to sort out. Available on `mention` and `implement` runs on a pull request crab'd can write to.

Changes the agent's sandbox so `git` cannot write to the repository, and removes the credentials `actions/checkout` leaves in `.git/config` before the turn starts. Every commit goes through the forge API, where the secret scan and the branch-moved guard run.

Adds a scope rule to `mention`. The comment that triggered the run is the instruction. The pull request body, other comments, and review threads are context.

Fixes a run that crashes or is cancelled leaving its tracking comment on "is working" forever. A post step now posts the failure.

Fixes `limits.timeout_minutes`, which was parsed and never enforced. It defaults to `20` and bounds the whole run, retries and fallback-model switches included. Set it to `0` for no ceiling.

Improves what a run tells you. The rate-limited comment names the model, the attempt and the wait, every comment links the run logs, and tool and turn events log without `CRABD_VERBOSE`.

#### Two things to update

Copy `timeout-minutes: 30` from the workflow template into your own workflow, as a backstop above `limits.timeout_minutes`.

If a later step in the same job pushed using the checkout's credentials, give it its own: re-run `actions/checkout`, or pass a token explicitly.

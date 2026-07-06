---
title: Troubleshooting
description: What crab'd's failure comments mean and how to fix them — the turn limit, timeouts, rate limits, config errors, and unexpected failures.
---

When a run fails, crab'd updates its tracking comment with what happened, what to change, and a
link back here — instead of a raw stack trace. This page expands on each failure it can post.

Every failure comment names the specific config knob to adjust. The knobs live under
[`limits`](/reference/config-yaml/#limits) and [`rate_limit`](/reference/config-yaml/#rate_limit)
in your [`.crabd.yml`](/reference/config-yaml/) (or the equivalent in
[`crabd.config.ts`](/reference/crabd-config-ts/)).

## Run hit the turn limit

> **crab'd** stopped … — it reached the tool-call limit before finishing.

Every run has a **hard ceiling** on tool-calling turns (`limits.max_turns`, default `40`). When a
run reaches it, crab'd is stopped mid-task. This is a safety valve against runaway loops and
unbounded CI cost — it is not injected into the prompt, so the model isn't biased into stopping
early.

Before it stops, crab'd reserves a few turns to ask the model for a **best-effort final answer** —
so the comment usually carries a partial result (what it found, what's still open) rather than
nothing. When it does, the comment is marked as partial.

Common causes:

- **The task was too broad for one run** — e.g. "review this" on a PR touching dozens of files, or
  an open-ended "look into X".
- **crab'd chased something it couldn't finish** — most often a file or **another repository** it
  has no access to (its token is scoped to the current repo), then looped retrying.

What to change:

1. **Narrow the request.** Point crab'd at the specific files or the specific change you want
   feedback on, or split a large PR into smaller ones.
2. **Raise the ceiling** only if the task genuinely needs more steps:

   ```yaml
   limits:
     max_turns: 80   # default 40
   ```

Raising `max_turns` trades CI minutes (and tokens) for headroom — prefer narrowing the task first.

## Run timed out

> **crab'd** ran out of time … — the run exceeded its time limit.

A wall-clock limit (`limits.timeout_minutes`) was set and the run exceeded it. Unlike the turn
limit, this is off by default — you only see it if you configured it.

What to change:

```yaml
limits:
  timeout_minutes: 20   # raise, or remove to disable
```

If runs routinely approach the limit, also consider narrowing the request (see above) or a faster
model for the mode.

## Rate limited

> **crab'd** … every model was rate-limited …

The provider rate-limited or overloaded crab'd, and every model in the fallback chain was
exhausted (or the wait budget ran out). This has its own tuning surface — backoff, an ordered
fallback-model chain, a wait budget, and per-mode soft/fail behavior. See
[Rate limiting & fallback models](/reference/rate-limiting/).

## Configuration is invalid

> **crab'd** couldn't start … — its configuration is invalid.

crab'd couldn't load or validate your config. The details block names the offending field. Check it
against the [`.crabd.yml` reference](/reference/config-yaml/) or
[`crabd.config.ts` reference](/reference/crabd-config-ts/), and see
[Config layering & governance](/config-layering/) if a value isn't taking effect (a higher layer may
override or forbid it).

## Cross-repo reads aren't working

> the agent can't read another repository you granted with `repos.read`

Most often the token can't reach it. `repos.read` needs a **cross-repo-capable** token: your own App
(`CRABD_APP_*`, installed on those repos) or a scoped PAT. Under the default **token broker** — which
vends single-repo tokens by design — `repos.read` is ignored (the run logs this). Check the run logs,
and see [Cross-repo access & private registries](/access/).

## Private registry install fails

> `pnpm install` / `npm install` can't authenticate

Confirm the secret is mapped to an env var **on the crab'd step** (`env: { NODE_AUTH_TOKEN: ${{
secrets.… }} }`), that the same name is in `sandbox.env` (or referenced by an `sandbox.npmrc` entry's
`token_env`), and that the registry URL/scope match your dependency. See
[Cross-repo access & private registries](/access/#private-npm-registries).

## Unexpected error

> **crab'd** hit an error …

A failure that doesn't fall into the categories above. The comment includes a collapsed **Error
details** block and a link to the run logs — start there. If it looks like a bug in crab'd, please
[open an issue](https://github.com/louisescher/crabd/issues).

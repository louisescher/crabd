---
title: Rate limiting & fallback models
description: How crab'd handles provider rate limits — computed backoff, an ordered fallback-model chain, a wait budget, and per-mode exhaustion behavior.
---

Every model provider rate-limits. When one does, crab'd doesn't just fail — it backs off, retries,
and can **fall back to a different model** (even a different provider) before giving up. This page
explains the behavior and how to tune it. For the bare field list, see
[`.crabd.yml` → `rate_limit`](/reference/config-yaml/#rate_limit).

## What crab'd actually adds

crab'd runs models through an agent framework that **already retries the same model** a few times with
exponential backoff before the error ever reaches crab'd. So crab'd's rate-limit layer focuses on the
things that framework can't do:

- **Fall back to a different model / provider** — an ordered `fallback_models` chain.
- **Reflect the state in the tracking comment** — "hit a rate limit… switching to fallback `…`".
- **Handle exhaustion gracefully** — soft-finish (don't block the PR) or fail, per mode.

Two constraints are worth knowing, because they shape what's tunable:

- **No `retry-after`.** The framework collapses provider errors to a plain string and drops rate-limit
  headers, so crab'd **can't honor a server's suggested wait**. All backoff is *computed*.
- **Detection is string-based.** crab'd classifies the error message (rate limit / overload / 5xx /
  network / quota) with a regex — the same signal the framework uses, plus `529`.

## How an attempt sequence runs

The attempt chain is `[primary model, ...fallback_models]`, walked **once in order**. Each attempt is
one full model call (which includes the framework's own same-model retries). On an in-scope failure,
crab'd waits a computed backoff, updates the comment, and moves to the **next** model — it does not
re-try the primary itself. The loop stops when a model succeeds, the chain ends, `max_retries` is
reached, or the `max_wait_seconds` budget runs out.

```yaml
rate_limit:
  fallback_models: [anthropic/claude-haiku-4-5, openai/gpt-5.5]
  max_retries: 4
  max_wait_seconds: 180   # total budget — caps CI minutes spent waiting
  trigger_scope: transient
  backoff:
    strategy: exponential # exponential | linear | constant
    initial_delay_seconds: 2
    max_delay_seconds: 30
    multiplier: 2
    jitter: true
```

If it completes on a fallback model, the result comment discloses it:
*"Primary model `anthropic/claude-sonnet-5` was rate-limited — completed with `anthropic/claude-haiku-4-5`."*

:::note
Fallback models are subject to the same [provider allowlist](/data-egress/) as the primary model. If a
fallback's provider isn't allowlisted, the run fails loudly at startup rather than silently routing
egress to an unapproved provider.
:::

## Which errors trigger it — `trigger_scope`

| Scope | Triggers on |
| --- | --- |
| `transient` *(default)* | Rate limits (429 / 529 / "rate limit" / "overloaded"), other transient errors (5xx / network / timeout), **and** hard quota/billing — the last only as a **cross-provider** fallback (retrying the same model would be futile). |
| `rate-limit` | Only rate limits / overload. Ignores generic 5xx and network errors. |
| `all` | Any model error, including otherwise-fatal ones (bad request, auth). Broadest; can mask real bugs behind a fallback. |

Anything not in scope is surfaced as a normal error (the run fails with the usual error comment).

## When the chain is exhausted — `on_exhausted`

Once every model has been tried (or the wait budget is spent), behavior is **per-mode by default**:

- **`review`** → soft-finish: the check stays **green** and the comment explains it was rate-limited,
  so a transient outage doesn't block your PR under branch protection.
- **`implement` / `mention`** (and custom modes) → **fail** the check (red), with the same explanation.

Set `on_exhausted: soft` or `on_exhausted: fail` to force one behavior for every mode.

## Backoff strategies

`backoff.strategy` shapes the delay between attempts (delay in seconds, clamped to `max_delay_seconds`):

| Strategy | Delay for retry _n_ |
| --- | --- |
| `exponential` *(default)* | `initial_delay_seconds × multiplier^(n-1)` — e.g. 2s, 4s, 8s… |
| `linear` | `initial_delay_seconds × n` — e.g. 2s, 4s, 6s… |
| `constant` | `initial_delay_seconds` every time |

With `jitter: true`, each delay is spread to 0.5×–1× of its value (equal jitter) to avoid a thundering
herd when many runs are limited at once.

## Governance

`rate_limit` merges through the [normal config layers](/config-layering/) and can be locked by the org
config repo — e.g. to mandate a fallback chain or forbid repos from disabling it:

```yaml
# in <owner>/.crabd-config/.crabd.yml
rate_limit:
  fallback_models: [anthropic/claude-haiku-4-5]
governance:
  locked: [rate_limit.fallback_models]
```

## CI input shortcut

The fallback chain can also be set from the workflow without a `.crabd.yml`:

```yaml
- uses: louisescher/crabd@v0
  with:
    fallback-models: anthropic/claude-haiku-4-5, openai/gpt-5.5
```

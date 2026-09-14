---
title: Config layering & governance
description: How crab'd resolves config across layers, and how an org keeps control.
---

crab'd's config comes from up to five sources.

## The five layers

From lowest to highest precedence:

1. **Built-in defaults**: shipped with crab'd.
2. **Org config repo**: `.crabd.yml` in `<owner>/.crabd-config` (configurable). The only layer that
   can _govern_.
3. **Repo**: the target repo's `.crabd.yml`. Read from the checkout, except on a pull request,
   where it's read from the default branch. See
   [The repo layer on a pull request](#the-repo-layer-on-a-pull-request).
4. **CI inputs**: `with:` inputs on the action (`model`, `trigger-phrase`, `providers`, ...).
5. **Environment**: an advanced `CRABD_CONFIG_ENV` YAML blob.

Higher layers win, but _how_ they win depends on the value.

## Three merge rules

| Kind             | Rule                                                                                                  | Examples                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **Scalars**      | Highest layer that sets it wins.                                                                      | `model`, `trigger_phrase`, `thinking_level`, `limits.*` |
| **Instructions** | **Accumulate**: concatenated across every layer, in order.                                            | `prompt.instructions`, `modes.*.instructions`           |
| **Value lists**  | **Replaced** by the highest layer that sets them.                                                     | `providers.allowlist`, `modes.*.tools`                  |
| **Keyed lists**  | **Reconciled by key**: a higher layer merges into a same-key entry field by field, and adds new ones. | `providers.custom` (by `id`), `mcp` (by `name`)         |

### Why the split matters

- Because instructions _accumulate_, org house rules are always in effect and repos add to them. See
  [Custom prompts](/custom-prompts/#instructions-accumulate-across-layers).
- Because lists are _replaced_, a repo that sets `providers.allowlist` overrides the org's list
  entirely, unless the org **locks** it (below).

## Worked example

```yaml title="org: <owner>/.crabd-config/.crabd.yml"
model: anthropic/claude-sonnet-4-6
providers:
  allowlist: [anthropic]
prompt:
  instructions: "- Never add a dependency without justification."
```

```yaml title="repo: .crabd.yml"
model: openai/gpt-5.5
providers:
  allowlist: [anthropic, openai]
prompt:
  instructions: "- This service is latency-sensitive."
```

Resolved: `model = openai/gpt-5.5` (scalar, repo wins), `providers.allowlist = [anthropic, openai]`
(list, repo replaces), and **both** instruction lines are present (accumulated).

## Governance: locking

Only the **org config repo** can govern, via a `governance` block.

### Locked keys

List dot-paths that lower layers cannot override.

```yaml title="org config"
providers:
  allowlist: [anthropic]
governance:
  locked: [providers.allowlist]
```

Now the repo example above resolves to `providers.allowlist = [anthropic]`, the repo's `[anthropic,
openai]` is ignored. Locked keys ignore the repo, CI inputs, **and** env.

### Full-override allowlist

Replacing the base prompt is off by default and only permitted for repos the org names. See
[Custom prompts → full override](/custom-prompts/#replacing-the-base-prompt-full-override).

## The repo layer on a pull request

On a pull request, the whole repo layer is read from the repository's **default branch**, and the
`.crabd.yml` in the checkout is ignored.

```yaml title="default branch: .crabd.yml"
permissions:
  secret_scan: false
modes:
  implement:
    enabled: true
```

```yaml title="PR checkout: .crabd.yml"
permissions:
  secret_scan: true
```

Resolved: `secret_scan` is `false` and `implement` is enabled. The checkout's file contributes
nothing, including the keys it happens to be the only one setting, and a setting pushed to the
default branch takes effect on an already-open pull request.

Nearly every key decides how the run treats the change it's looking at. `permissions` grants the
write token, `modes` picks which mode runs and what it's told, `prompt` and `review` rewrite the
model's instructions, `sandbox.env` forwards named secrets into a shell the same file can steer,
and `providers.custom` points the model call at an arbitrary endpoint. A pull request head is
contributor-controlled, so it sets none of them.

A `crabd.config.ts` extension is skipped on a pull request for the same reason: it's code, and it
runs inside the process holding crab'd's forge token.

crab'd uses the checkout as-is, with no extra fetch, when the run isn't on a pull request or when
the PR's head branch is already the default branch. An absent, empty, or unparseable file on the
default branch falls back to the org and built-in layers.

To test a `.crabd.yml` change, merge it to the default branch, then re-run on the open pull
request with a mention.

## Reading the org config repo

crab'd fetches `<owner>/.crabd-config/.crabd.yml` using its forge token, so that token needs org read
scope, which is why a [GitHub App or the broker](/identity/) is recommended over the repo-scoped
`GITHUB_TOKEN`. Change the location with `CRABD_ORG_CONFIG_REPO` / `CRABD_ORG_CONFIG_PATH`.

## See also

- [.crabd.yml reference](/reference/config-yaml/): every field, type, and default.
- [Data egress & security](/data-egress/): using locking.

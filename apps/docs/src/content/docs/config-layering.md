---
title: Config layering & governance
description: How crab'd resolves config across layers, and how an org keeps control.
---

crab'd's config comes from up to five sources.

## The five layers

From lowest to highest precedence:

1. **Built-in defaults**: shipped with crab'd.
2. **Org config repo**: `.crabd.yml` in `<owner>/.crabd-config` (configurable). The only layer that
   can *govern*.
3. **Repo**: the target repo's `.crabd.yml`.
4. **CI inputs**: `with:` inputs on the action (`model`, `trigger-phrase`, `providers`, ...).
5. **Environment**: an advanced `CRABD_CONFIG_ENV` YAML blob.

Higher layers win, but *how* they win depends on the value.

## Three merge rules

| Kind | Rule | Examples |
| --- | --- | --- |
| **Scalars** | Highest layer that sets it wins. | `model`, `trigger_phrase`, `thinking_level`, `limits.*` |
| **Instructions** | **Accumulate**: concatenated across every layer, in order. | `prompt.instructions`, `modes.*.instructions` |
| **Value lists** | **Replaced** by the highest layer that sets them. | `providers.allowlist`, `modes.*.tools` |
| **Keyed lists** | **Reconciled by key**: a higher layer overrides a same-key entry and adds new ones. | `providers.custom` (by `id`), `mcp` (by `name`) |

### Why the split matters

- Because instructions *accumulate*, org house rules are always in effect and repos add to them. See
  [Custom prompts](/custom-prompts/#instructions-accumulate-across-layers).
- Because lists are *replaced*, a repo that sets `providers.allowlist` overrides the org's list
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

## Reading the org config repo

crab'd fetches `<owner>/.crabd-config/.crabd.yml` using its forge token, so that token needs org read
scope, which is why a [GitHub App or the broker](/identity/) is recommended over the repo-scoped
`GITHUB_TOKEN`. Change the location with `CRABD_ORG_CONFIG_REPO` / `CRABD_ORG_CONFIG_PATH`.

## See also

- [.crabd.yml reference](/reference/config-yaml/): every field, type, and default.
- [Data egress & security](/data-egress/): using locking.

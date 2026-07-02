---
title: Configuration
description: Every dial in .crabd.yml, how layers merge, and how orgs govern it.
---

crab'd is configured with a drop-in **`.crabd.yml`** at your repo root. Everything you'll normally
touch lives there. For things that want real code (output schemas, custom tools,
custom modes), add an optional [`crabd.config.ts`](#the-crabdconfigts-extension).

## How layers merge

crab'd resolves config from five layers, lowest to highest precedence:

1. **Built-in defaults**
2. **Org config repo** — `.crabd.yml` in `<owner>/.crabd-config` (see [governance](#org-governance))
3. **Repo** — your `.crabd.yml`
4. **CI inputs** — `with:` inputs on the action
5. **Environment** — an advanced `CRABD_CONFIG_ENV` YAML override

The merge rules are deliberately predictable:

| Kind | Rule |
| --- | --- |
| Scalars (`model`, `trigger_phrase`, ...) | Highest layer wins |
| `prompt.instructions` and per-mode `instructions` | **Accumulate** across all layers, in order |
| Lists (`providers.allowlist`, `modes.*.tools`) | **Replaced** by the highest layer |

:::tip
Because instructions accumulate, an org can set house rules once and every repo inherits them. Repos 
only add their own on top.
:::

## Org governance

Put a `.crabd.yml` in a private `<owner>/.crabd-config` repo to set org-wide defaults. Two governance
keys make it authoritative:

```yaml title="<owner>/.crabd-config/.crabd.yml"
providers:
  allowlist: [anthropic]

governance:
  # Keys no repo may override.
  locked: [providers.allowlist]
  # Repos permitted to fully replace the system prompt.
  full_override_repos: [acme/trusted-repo]
```

A **locked** key can't be changed by any lower layer — not the repo file, not CI inputs, not env.
This is how you guarantee repo code only reaches approved providers.

:::note
Reading the org config repo needs a token with org scope. See [Operating crab'd](/self-hosting/) —
a GitHub App is the recommended way.
:::

## Prompt override

By default, repos can only *append* to the base prompt. To let a repo replace it entirely, the org
must allowlist the repo **and** the repo must opt in:

```yaml title=".crabd.yml (in an allowlisted repo)"
prompt:
  allow_full_override: true
  override: |
    You are our house reviewer. Only comment on security and data-handling issues.
```

If the org hasn't listed the repo in `full_override_repos`, the override is ignored and the base
prompt is used.

## The `crabd.config.ts` extension

Add `crabd.config.ts` next to `.crabd.yml` for the code-y parts: [output schemas](/output-schemas/)
and [custom modes/tools](/custom-modes/).

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  schemas: {
    review: v.object({
      summary: v.string(),
      blocking: v.boolean(),
    }),
  },
});
```

## More capabilities

- **Live progress.** The agent posts progress updates to its tracking comment as it works. crab'd reuses one 
  comment per issue/PR instead of stacking new ones, and labels its own prior replies so it has conversational 
  continuity across mentions.
- **Images.** Images in the triggering comment or the issue/PR body are passed to a vision-capable model.
- **Faithful commits.** crab'd commits additions, modifications, **deletions, renames, and binary files**.
- **MCP tools.** Tools from the `mcp` servers are available to the agent during the run.

:::note
Two things are intentionally out of scope in ephemeral CI: **persistent agent sessions** across runs and
a **sandbox network-egress allowlist** (Flue's local sandbox doesn't expose one).
:::

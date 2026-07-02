---
title: crabd.config.ts
description: The optional TypeScript extension — output schemas, custom tools, and custom modes.
---

`crabd.config.ts` (at your repo root, next to `.crabd.yml`) is the optional code extension for the
parts that want real types rather than YAML: **output schemas**, **custom tools**, and **custom
modes**. It's loaded at runtime with [jiti](https://github.com/unjs/jiti), so no build step is needed.

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  schemas: { /* ... */ },
  modes: [ /* ... */ ],
  tools: [ /* ... */ ],
});
```

:::caution[Use valibot, not zod]
Schemas here cross into Flue's agent API, which is **valibot-typed** (`v.GenericSchema`). Zod schemas
won't type-check. Import `* as v from 'valibot'`.
:::

## `defineCrabdConfig(extension)`

Identity helper that gives you type-checking and editor completion. Returns the extension unchanged.

### `CrabdExtension`

| Field | Type | Description |
| --- | --- | --- |
| `schemas` | `Record<string, ValibotSchema>` | Per-mode output schema overrides, keyed by mode name. Replaces the built-in schema for that mode. |
| `tools` | `ToolDefinition[]` | Custom model-callable tools (from Flue's `defineTool`). |
| `modes` | `ModeDefinition[]` | Custom modes registered into the mode registry. |

## `ModeDefinition`

A mode turns one event into one agent run: it declares the output schema the model must satisfy and a
`finalize` step that performs the forge side effects.

| Field | Type | Description |
| --- | --- | --- |
| `name` | `string` | Mode name; also the mention sub-command (`/crabd <name> ...`). |
| `outputSchema` | `ValibotSchema` | The structured output the model must produce and that `finalize` receives. |
| `tools` | `string[]` | Forge operations the mode uses (descriptive). |
| `finalize` | `(ctx: FinalizeContext) => Promise<FinalizeResult>` | Performs forge side effects from the validated output. |

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  modes: [
    {
      name: 'triage',
      outputSchema: v.object({ labels: v.array(v.string()), comment: v.string() }),
      tools: ['comment'],
      async finalize(ctx) {
        return { summary: ctx.data.comment };
      },
    },
  ],
});
```

### `FinalizeContext<T>`

| Field | Type | Description |
| --- | --- | --- |
| `data` | `T` | The model's structured output, validated against `outputSchema`. |
| `adapter` | `ForgeAdapter` | The forge (GitHub or Forgejo): post comments/reviews, commit, open PRs, read config. |
| `config` | `ResolvedConfig` | The fully resolved configuration for this run. |
| `event` | `ForgeEvent` | The normalized triggering event. |
| `context` | `ForgeContext` | Fetched issue/PR, comments, diff, and changed files. |
| `trigger` | `TriggerResult` | The detected mode and post-mention `userInstruction`. |
| `cwd` | `string` | Working directory of the checked-out repo. |

### `FinalizeResult`

| Field | Type | Description |
| --- | --- | --- |
| `summary` | `string` | Text rendered into the tracking comment. |
| `prUrl` | `string` (optional) | URL of a PR the mode opened/updated. |

## Overriding a built-in schema

Provide a `schemas` entry keyed by the mode name. crab'd validates the model's output against it and
uses it for both the CI output and the rendered comment:

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  schemas: {
    review: v.object({
      summary: v.string(),
      risk: v.picklist(['low', 'medium', 'high']),
      must_fix: v.array(v.string()),
    }),
  },
});
```

## `ForgeAdapter` (for custom `finalize`)

The subset of methods most useful inside `finalize`:

| Method | Description |
| --- | --- |
| `createTrackingComment(target, body)` / `updateTrackingComment(ref, body)` | Manage the tracking comment. |
| `postReview(prNumber, review)` | Submit a PR review with a verdict and inline comments. |
| `commitToBranch(request)` | Commit file changes (upserts/deletes, binary-safe) to a branch. |
| `openOrUpdatePR(request)` | Open or update a pull request. |
| `readOrgConfig(repoSlug, path)` | Read a file from another repo (e.g. org config). |

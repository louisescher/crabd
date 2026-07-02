---
title: Custom modes
description: Register your own modes beyond mention, review, and implement.
---

The three built-in modes cover most needs, but the mode registry is open. Define your own mode in
`crabd.config.ts` and crab'd will run it like any built-in.

:::tip
A custom mode's **name is its trigger keyword automatically** — register a `triage` mode and
`/crabd triage …` routes to it, with the rest of the comment passed as the instruction. Disabling a
mode in config removes its keyword (an explicit `/crabd <disabled>` then does nothing).
:::

## Anatomy of a mode

A mode declares:

- a **name** (also the mention keyword, e.g. `/crabd triage`),
- an **output schema** (the structured result the model must produce), and
- a **`finalize`** step that performs the forge side effects from that output.

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

const triageOutput = v.object({
  labels: v.array(v.string()),
  comment: v.string(),
});

export default defineCrabdConfig({
  modes: [
    {
      name: 'triage',
      outputSchema: triageOutput,
      tools: ['comment'],
      async finalize(ctx) {
        // ctx.data is validated against triageOutput.
        // ctx.adapter is the forge (GitHub or Forgejo), ctx.context has the issue/PR.
        return { summary: ctx.data.comment };
      },
    },
  ],
});
```

## How `finalize` receives context

`finalize(ctx)` runs after the model returns validated output. `ctx` gives you:

- `ctx.data`: the validated structured output,
- `ctx.adapter`: the forge adapter (post comments, reviews, commits, PRs),
- `ctx.context`: the fetched issue/PR, comments, diff, and changed files,
- `ctx.config`, `ctx.event`, `ctx.trigger`, `ctx.cwd`.

Return a `summary` (rendered into the tracking comment) and optionally a `prUrl`.

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

On a pull request, `ctx.context` also carries `reviewThreads` (every unresolved review conversation,
with its id and anchor), `reviews` (the submitted review bodies), and `checks` (the CI state for the
head commit). These are fetched only for a run that renders them, so a mode that wants them should
say so in its own prompt.

Return a `summary` (rendered into the tracking comment) and optionally a `prUrl`. Set
`handledThreadReplies: true` when the mode already replied to the triggering review conversation
itself, which stops crab'd posting the summary there a second time.

## Modes that write

If your `finalize` commits or opens a pull request, declare it:

```ts
{
  name: 'backport',
  tools: ['comment', 'commit'],
  writes: 'required', // or 'optional'
  // …
}
```

`'required'` means the mode has no useful read-only form, so it is gated out entirely when
[writes are off](/reference/config-yaml/#read-only-runs). `'optional'` means it still runs and skips
the write: check `ctx.config.permissions.write` in `finalize` and say what you did instead. Pass
that same flag to `commitWorkingChanges({ …, writesAllowed: ctx.config.permissions.write })`, which
throws rather than committing when writes are disabled.

## Checking output before acting on it

A mode can add a `validate(data, ctx)` step, which runs after the schema check and before
`finalize`. Return `{ ok: true }`, or `{ ok: false, repairPrompt }` to send the model a correction
on the same session, keeping everything it has already read. `ctx` carries `changedPaths`,
`anchorable` (the lines a forge accepts an inline comment on), `cwd`, `subjectKind`, `threadIds`
(the review conversations the prompt rendered), and `verifyCommands`.

This is for output that is well-typed and wrong about the world: a finding on a line the forge will
reject, an answer for a review conversation that does not exist. Without it, those are discovered
in `finalize`, long after the model is gone.

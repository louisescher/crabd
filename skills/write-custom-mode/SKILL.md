---
name: write-custom-mode
description: Scaffold a custom crab'd mode in crabd.config.ts — a Valibot output schema plus a finalize step that performs forge side effects. Use when a user wants behavior beyond mention/review/implement (e.g. triage, changelog, security-scan).
---

# Write a custom crab'd mode

Add a mode to `crabd.config.ts`. A mode = a name (its trigger keyword), a Valibot output schema, and a
`finalize` step. Read the `crabd.config.ts` reference first for exact types.

## 1. Clarify the mode

- **Name** — becomes the keyword: `@crabd <name> …`.
- **What the model must produce** — the structured output shape.
- **What crab'd should do with it** — comment, review, commit, open a PR?

## 2. Scaffold

```ts title="crabd.config.ts"
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  modes: [
    {
      name: 'triage',
      outputSchema: v.object({
        labels: v.array(v.string()),
        comment: v.string(),
      }),
      tools: ['comment'],
      async finalize(ctx) {
        // ctx.data is validated against outputSchema.
        // ctx.adapter posts comments/reviews/commits/PRs; ctx.context has the issue/PR.
        return { summary: ctx.data.comment };
      },
    },
  ],
});
```

## 3. Rules to honor

- **Valibot only** (`v`), never zod — the schema crosses Flue's typed API.
- The `name` is automatically the trigger keyword; nothing else to wire.
- `finalize` returns `{ summary, prUrl? }`. Use `ctx.adapter` for side effects:
  `postReview`, `commitToBranch`, `openOrUpdatePR`, `updateTrackingComment`.
- Keep side effects idempotent where possible — a mode may re-run.

## 4. Enable & test

Custom modes are enabled by default. Trigger with `@crabd <name> …` and confirm the run posts what
`finalize` returns. To disable, set `modes.<name>.enabled: false` in `.crabd.yml`.

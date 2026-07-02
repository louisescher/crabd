---
title: Output schemas
description: Force structured output, emit it as a CI output, and shape the comment.
---

Every mode declares a **Valibot output schema** the model must satisfy. crab'd uses that structured
output two ways at once:

1. **As a machine-readable CI output**: emitted as the action's `result` output so downstream
   workflow steps can gate on it.
2. **To shape what crab'd posts**: the review body, inline findings, the PR title/body, and the
   tracking comment are all derived from it.

## Built-in schemas

Each built-in mode already has a schema. For example, `review` produces:

```ts
v.object({
  summary: v.string(),
  verdict: v.picklist(['APPROVE', 'COMMENT', 'REQUEST_CHANGES']),
  findings: v.array(v.object({ path: v.string(), line: v.number(), body: v.string() })),
});
```

crab'd validates the model's output against this before doing anything with it. An ill-formed
response is retried.

## Consuming the CI output

The action exposes the validated output as `result`:

```yaml title="workflow"
- id: crabd
  uses: louisescher/crabd@v0
  with:
    model: anthropic/claude-sonnet-4-6

- name: Gate on the review verdict
  if: ${{ fromJSON(steps.crabd.outputs.result).verdict == 'REQUEST_CHANGES' }}
  run: echo "Changes requested — blocking." && exit 1
```

The action also exposes `mode` and a human-readable `summary`.

## Overriding a schema

Provide your own schema for a mode in `crabd.config.ts`. It replaces the built-in schema for that
mode:

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

// Optional crab'd extension. Drop this at your repo root as `crabd.config.ts`.
// Use it for the code-y parts: custom output schemas, custom tools, and custom modes.
import { defineCrabdConfig } from '@crabd/config';
import * as v from 'valibot';

export default defineCrabdConfig({
  // Override the structured output schema for a built-in mode.
  schemas: {
    review: v.object({
      summary: v.string(),
      risk: v.picklist(['low', 'medium', 'high']),
      must_fix: v.array(v.string()),
    }),
  },

  // Register a custom mode. Triggered via `@crabd triage`.
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

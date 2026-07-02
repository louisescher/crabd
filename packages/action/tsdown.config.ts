import { defineConfig } from 'tsdown';

// Only the CLI orchestrator is bundled to dist. The Flue app (src/workflows, src/app.ts)
// is discovered and built by `flue build` — not by tsdown.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: false,
});

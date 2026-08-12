import { defineConfig } from 'tsdown';

// One bundle: the CLI is the whole program. The agents run in-process via `start()`, so there is no
// separate Flue server to build and `clean` is safe now that nothing else writes to dist.
export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
});

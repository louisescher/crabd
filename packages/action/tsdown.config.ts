import { defineConfig } from 'tsdown';

// Two bundles: `post` is the action's post step, which has to survive the CLI process crashing.
export default defineConfig({
  entry: ['src/cli.ts', 'src/post.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
});

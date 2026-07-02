import { serve } from '@hono/node-server';
import { buildFromEnv } from './index.ts';

// Node entrypoint: `crabd-broker` (or `node dist/node.mjs`). For Cloudflare Workers,
// import `createBroker` and wire it to your Worker's secret bindings instead.
const app = buildFromEnv();
const port = Number(process.env.PORT ?? 8787);

serve({ fetch: app.fetch, port }, (info) => {
  process.stderr.write(`crabd-broker listening on :${info.port}\n`);
});

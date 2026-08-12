/**
 * Verify a self-hosted OpenAI-compatible endpoint end to end, the way a real run reaches it:
 * layered config → `buildProviders` → `setRunContext` → `start()` → one `mention` turn.
 *
 * Usage:
 *   CRABD_TOKEN_FILE=/path/to/token CRABD_BASE_URL=https://vllm.example/v1 \
 *     node --experimental-strip-types scripts/verify-custom-endpoint.ts
 *
 * Optional:
 *   CRABD_FALLBACK_MODEL=<id>   also check the rate-limit fallback chain (point CRABD_BASE_URL at a
 *                               proxy that 429s the primary model)
 *   CRABD_MCP_URL=<url>         also check that an MCP server's tools mount
 *
 * A model that answers here but loops emitting a single reasoning token in CI almost always means the
 * resolved `context_window` did not survive config layering — check `unsized models` in the output.
 */
import { readFileSync } from 'node:fs';
import { resolveConfig, type CrabdConfigPartial } from '@crabd/config';
import { registerBuiltinModes } from '@crabd/core';
import { start } from '@flue/runtime/node';
import { CrabdRefuter } from '../packages/action/src/agents/crabd-refuter.ts';
import { CrabdTurn } from '../packages/action/src/agents/crabd-turn.ts';
import { buildProviders, unsizedCustomModels } from '../packages/action/src/providers.ts';
import { buildRunContext, setRunContext } from '../packages/action/src/run-context.ts';
import { runTurn } from '../packages/action/src/turn-runner.ts';

const BASE_URL = process.env.CRABD_BASE_URL ?? 'http://127.0.0.1:8799/v1';
const PRIMARY = process.env.CRABD_PRIMARY_MODEL ?? 'deepseek-v4-flash-max';
const FALLBACK = process.env.CRABD_FALLBACK_MODEL;
const MCP_URL = process.env.CRABD_MCP_URL;

process.env.DEEPSEEK_API_KEY = readFileSync(process.env.CRABD_TOKEN_FILE!, 'utf-8').trim();

// The two-layer shape a real org uses: a placeholder endpoint in the org config, the real one injected
// per run. Exercising both layers is the point — a field lost in the merge is the failure mode.
const org: CrabdConfigPartial = {
  model: `deepseek/${PRIMARY}`,
  providers: {
    allowlist: ['deepseek'],
    custom: [
      {
        id: 'deepseek',
        base_url: 'http://REPLACE-ME:8000/v1',
        api: 'openai-completions',
        api_key_env: 'DEEPSEEK_API_KEY',
        context_window: 1_048_576,
        reasoning: true,
      },
    ],
  },
  web_search: { enabled: false },
  limits: { max_turns: 20 },
  ...(FALLBACK ? { rate_limit: { fallback_models: [`deepseek/${FALLBACK}`], max_wait_seconds: 30 } } : {}),
  ...(MCP_URL ? { mcp: [{ name: 'probe', url: MCP_URL }] } : {}),
  governance: { locked: ['providers.allowlist'] },
};

const config = resolveConfig({
  layers: { org, env: { providers: { custom: [{ id: 'deepseek', base_url: BASE_URL }] } } },
});

const providers = buildProviders(config);
console.log('providers registered :', providers?.length, '(deepseek:', providers?.some((p) => p.id === 'deepseek'), ')');
console.log('resolved base_url    :', config.providers.custom[0]?.baseUrl);
console.log('resolved window      :', config.providers.custom[0]?.contextWindow);
console.log('unsized models       :', unsizedCustomModels(config));
console.log('fallback chain       :', config.rateLimit.fallbackModels);
console.log('mcp servers          :', config.mcp.map((m) => m.name));

registerBuiltinModes();
setRunContext(buildRunContext({ config, cwd: new URL('..', import.meta.url).pathname, runId: `verify-${Date.now()}` }));

const flue = await start({ agents: [CrabdTurn, CrabdRefuter], ...(providers ? { providers } : {}) });

try {
  const started = Date.now();
  const outcome = await runTurn(
    {
      mode: 'mention',
      message: MCP_URL
        ? 'Call the mcp__probe__ping tool, then submit its result as your response. Do not read any files.'
        : 'What is 2+2? Answer in one word. Do not read any files.',
      instructions: 'Be concise.',
    },
    config.rateLimit,
    config.model,
  );
  console.log(`\nturn (${Math.round((Date.now() - started) / 1000)}s) ok=${outcome.ok}`);
  console.log('meta                 :', JSON.stringify(outcome.meta));
  console.log('data                 :', JSON.stringify(outcome.data ?? outcome.error).slice(0, 300));
} finally {
  await flue.stop();
}

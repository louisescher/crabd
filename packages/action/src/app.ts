import { registerProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';

// Register a local Ollama endpoint when configured, so `ollama/*` model specifiers
// resolve (multi-provider support for self-hosted models).
if (process.env.CRABD_OLLAMA_BASE_URL) {
  registerProvider('ollama', {
    api: 'openai-completions',
    baseUrl: process.env.CRABD_OLLAMA_BASE_URL,
  });
}

// Register user-defined custom providers (OpenAI-compatible endpoints with their
// own URLs) resolved from `providers.custom` in the config and passed by the CLI.
const customProvidersRaw = process.env.CRABD_CUSTOM_PROVIDERS;
if (customProvidersRaw) {
  try {
    const providers = JSON.parse(customProvidersRaw) as {
      id: string;
      baseUrl: string;
      api?: string;
      apiKeyEnv?: string;
    }[];
    for (const p of providers) {
      const apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
      registerProvider(p.id, {
        api: p.api ?? 'openai-completions',
        baseUrl: p.baseUrl,
        ...(apiKey ? { apiKey } : {}),
      });
    }
  } catch {
    // Malformed CRABD_CUSTOM_PROVIDERS is ignored; the allowlist still gates usage.
  }
}

// Route allowlisted built-in providers through the org egress gateway from
// `providers.gateway_url`. Each provider keeps its catalog metadata and normal
// credentials; only its endpoint changes to `${gateway}/<provider>`.
if (process.env.CRABD_GATEWAY_URL && process.env.CRABD_GATEWAY_PROVIDERS) {
  const gateway = process.env.CRABD_GATEWAY_URL.replace(/\/$/, '');
  try {
    const providers = JSON.parse(process.env.CRABD_GATEWAY_PROVIDERS) as string[];
    for (const id of providers) {
      registerProvider(id, { baseUrl: `${gateway}/${id}` });
    }
  } catch {
    // Malformed gateway config is ignored.
  }
}

const app = new Hono();
app.route('/', flue());

export default app;

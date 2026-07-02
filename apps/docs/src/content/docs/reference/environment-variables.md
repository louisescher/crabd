---
title: Environment variables
description: Every environment variable crab'd reads or sets, grouped by purpose.
---

crab'd is configured mostly through [`.crabd.yml`](/reference/config-yaml/), but a handful of things —
secrets, identity, and forge/runner wiring — come from the environment. This is the complete list.

:::tip
On GitHub/Forgejo Actions, use the [action inputs](#action-inputs) where possible; they map to these
variables for you. Set the rest via the workflow's `env:` (secrets for anything sensitive).
:::

## Identity & authentication

| Variable | Description |
| --- | --- |
| `CRABD_APP_ID` | GitHub App ID. With `CRABD_APP_PRIVATE_KEY`, authenticates as that App (self-hosted identity). Overrides the broker. |
| `CRABD_APP_PRIVATE_KEY` | GitHub App private key. A raw PEM **or** a base64-encoded PEM (easier as an env var). |
| `CRABD_APP_INSTALLATION_ID` | Optional installation ID. Auto-resolved from the repo when omitted. |
| `CRABD_BROKER_URL` | Token-broker URL for the canonical `crab'd[bot]` identity. Defaults to the built-in `DEFAULT_BROKER_URL`. |
| `CRABD_BROKER_AUDIENCE` | OIDC audience the broker expects. Default `crabd-broker`. |
| `CRABD_DISABLE_BROKER` | Set to `true` to skip the broker even when OIDC is available. |
| `CRABD_GITHUB_TOKEN` | GitHub token for forge ops (fallback identity: `github-actions`). |
| `CRABD_GITHUB_API_URL` | GitHub API base URL (GitHub Enterprise). |

## Forge selection (Forgejo)

| Variable | Description |
| --- | --- |
| `CRABD_FORGE` | Force the forge: `github` or `forgejo`. Auto-detected otherwise. |
| `CRABD_FORGEJO_TOKEN` | Bot-account token — crab'd's identity on Forgejo. |
| `CRABD_FORGEJO_API_URL` | Forgejo API root, e.g. `https://forgejo.example.com/api/v1`. |

## Config layering

| Variable | Description |
| --- | --- |
| `CRABD_INPUT_MODEL` | Model for the **inputs** layer (from the `model` action input). |
| `CRABD_INPUT_TRIGGER_PHRASE` | Trigger phrase (inputs layer). |
| `CRABD_INPUT_PROVIDERS` | Comma-separated provider allowlist (inputs layer). |
| `CRABD_INPUT_THINKING_LEVEL` | Reasoning level (inputs layer). |
| `CRABD_CONFIG_ENV` | A YAML blob applied as the highest **env** config layer. |
| `CRABD_CONFIG_PATH` | Repo config filename. Default `.crabd.yml`. |
| `CRABD_ORG_CONFIG_REPO` | Org config repo slug. Default `<owner>/.crabd-config`. |
| `CRABD_ORG_CONFIG_PATH` | Path within the org repo. Default `.crabd.yml`. |
| `CRABD_EXTENSION_PATH_REL` | Repo-relative path to `crabd.config.ts`. Default `crabd.config.ts`. |

## Providers

| Variable | Description |
| --- | --- |
| `CRABD_OLLAMA_BASE_URL` | Registers a local Ollama provider at this OpenAI-compatible URL. |
| `TAVILY_API_KEY` | Enables reliable web search for the agent's `web_search` tool (falls back to keyless DuckDuckGo when unset). |

The egress gateway is configured via [`providers.gateway_url`](/reference/config-yaml/#providers) in
`.crabd.yml`, not by hand.

### Model provider credentials

Read by the provider integrations (not by crab'd directly). Provide the one(s) for your chosen model:

| Variable | Provider |
| --- | --- |
| `ANTHROPIC_API_KEY` | `anthropic` |
| `OPENAI_API_KEY` | `openai` |
| `OPENROUTER_API_KEY` | `openrouter` |
| `GEMINI_API_KEY` | `google` (Gemini) |
| `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | `google-vertex` (Vertex AI, ADC) |
| *(your `api_key_env`)* | a [custom provider](/providers/#custom-openai-compatible-providers) |

## Runner-provided (read automatically)

Set by the CI runner; crab'd reads them. You rarely set these yourself.

| Variable | Description |
| --- | --- |
| `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` | The event kind and payload file. |
| `GITHUB_WORKSPACE` | The checked-out repo path (the agent's sandbox root). |
| `GITHUB_TOKEN` | Fallback forge token. |
| `GITHUB_API_URL` / `GITHUB_SERVER_URL` | API / server base URLs. |
| `GITHUB_OUTPUT` | File crab'd writes its `mode` / `result` / `summary` outputs to. |
| `FORGEJO_ACTIONS` | Present on Forgejo runners; aids forge auto-detection. |
| `ACTIONS_ID_TOKEN_REQUEST_URL` / `ACTIONS_ID_TOKEN_REQUEST_TOKEN` | OIDC minting endpoint (requires `permissions: id-token: write`). |
| `CRABD_EVENT_NAME` / `CRABD_EVENT_PATH` | Override the event source (useful outside Actions). |

## Broker service

Set on the deployed [broker](/self-hosting/#run-your-own-broker), not in consumer workflows.

| Variable | Description |
| --- | --- |
| `CRABD_APP_ID` / `CRABD_APP_PRIVATE_KEY` | The canonical crab'd App credentials the broker holds. The key may be a raw PEM or base64-encoded. |
| `CRABD_BROKER_AUDIENCE` | Audience the broker requires. Default `crabd-broker`. |
| `PORT` | Node listen port. Default `8787`. |

## Advanced / internal

Set by the CLI for the Flue turn subprocess. You normally don't set these, but they're documented for
non-Actions embedding.

| Variable | Description |
| --- | --- |
| `CRABD_MODEL`, `CRABD_INSTRUCTIONS`, `CRABD_THINKING_LEVEL` | Resolved dials handed to the agent. |
| `CRABD_CWD` | Sandbox working directory. |
| `CRABD_TIMEOUT_MS` | Hard run timeout in milliseconds (from `limits.timeout_minutes`). |
| `CRABD_CUSTOM_PROVIDERS` | JSON of resolved custom providers to register. |
| `CRABD_GATEWAY_URL` / `CRABD_GATEWAY_PROVIDERS` | Gateway base URL and the built-in providers to route through it (from `providers.gateway_url`). |
| `CRABD_MCP` | JSON of MCP servers to connect. |
| `CRABD_WEB_SEARCH` | JSON of the resolved web-search config (`enabled`, `maxResults`). |
| `CRABD_EXTENSION_PATH` | Absolute path to `crabd.config.ts`. |
| `CRABD_SANDBOX_ENV` | JSON of extra env vars exposed to the sandbox (empty by default). |
| `CRABD_FORGE_TOKEN`, `CRABD_REPO_OWNER`, `CRABD_REPO_NAME`, `CRABD_REPO_DEFAULT_BRANCH`, `CRABD_TRACKING_ID`, `CRABD_SUBJECT` | Wiring for the live-progress tool. |

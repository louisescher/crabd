---
name: deploy-crabd-broker
description: Deploy the crab'd token broker so repos get the canonical crab'd[bot] identity via OIDC. Use when someone wants one shared bot identity across many repos/orgs instead of per-repo App keys.
---

# Deploy the crab'd broker

The broker (`packages/broker`, `@crabd/broker`) holds the canonical crab'd App's private key and vends
short-lived, repo-scoped installation tokens after verifying a run's GitHub OIDC token. Deploy it so
workflows can use the canonical `crab'd[bot]` with only `permissions: id-token: write`.

## 1. Prerequisites

- The **canonical crab'd GitHub App** created (from `app/manifest.json`) and **installed** on the
  target repos/org.
- Its **App ID** and **private key (PEM)**.

## 2. Configure

The broker reads:

- `CRABD_APP_ID`, `CRABD_APP_PRIVATE_KEY` — the App credentials (server secrets). The key may be a
  raw PEM or a **base64-encoded** PEM (easier to store as a single-line env var:
  `base64 -w0 crabd-app.pem`).
- `CRABD_BROKER_AUDIENCE` — OIDC audience (default `crabd-broker`); must match what the action sends.
- `PORT` — Node listen port (default `8787`).

## 3. Deploy

**Node** (container or host):

```bash
pnpm --filter @crabd/broker build
CRABD_APP_ID=... CRABD_APP_PRIVATE_KEY="$(cat key.pem)" node packages/broker/dist/node.mjs
```

**Cloudflare Workers**: import `createBroker` from `@crabd/broker` and wire it to a Worker `fetch`
handler, providing the App credentials from Worker secrets (don't use the Node entry).

Put it behind HTTPS and note the public URL. Health check: `GET /health` → `{ ok: true }`.

## 4. Point workflows at it

If not baking the URL into `DEFAULT_BROKER_URL`, set it per workflow:

```yaml
- uses: louisescher/crabd@v1
  with:
    broker-url: https://your-broker.example.com
```

## 5. Verify

Trigger a run in a repo where the App is installed, with `id-token: write`. Confirm the comment posts
as `crab'd[bot]` and the broker logs a successful `/token` exchange. A 502 usually means the App isn't
installed on that repo; a 401 means an audience/issuer mismatch.

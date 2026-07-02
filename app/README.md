# The crab'd GitHub App

Comments come from a **crab'd bot** identity (rather than `github-actions`) only when crab'd
authenticates as a **GitHub App**. This manifest defines that App.

There are two ways it's used:

- **Canonical crab'd[bot] (default).** One published crab'd App, owned centrally, whose key lives only
  in the [token broker](../packages/broker). Users just **install** the App and give their workflow
  `id-token: write`; the broker vends short-lived, repo-scoped tokens after verifying the run's OIDC
  token. No key is ever distributed. See [self-hosting docs](../apps/docs/src/content/docs/self-hosting.md).
- **Your own App (self-host).** Create your own crab'd App from this manifest, hold its key, and pass
  `app-id` / `app-private-key` to the action. This overrides the broker.

## Create the App

Open [`register.html`](./register.html) in a browser — it opens GitHub's *New GitHub App* form
**pre-filled** with crab'd's permissions and events (webhook disabled). Enter a unique App name and
(optionally) your org, then:

1. Click **Create GitHub App**. Names are globally unique on GitHub, so if `crabd` is taken, pick
   another (e.g. `crabd-yourname`).
2. On the App's page, note the **App ID** and click **Generate a private key** (downloads a `.pem`).
3. Under **Display information**, upload a **logo**. This is the avatar shown on crab'd's comments and
   reactions. Use [`../apps/docs/public/favicon.png`](../apps/docs/public/favicon.png) or your own.
4. Open **Install App** and install it on the repos/org crab'd should act on.

Permissions requested: `contents`, `issues`, `pull_requests` (write) and `metadata` (read). Events:
`issue_comment`, `issues`, `pull_request`.

> **Note:** `register.html` uses GitHub's **query-parameter pre-fill**, which needs no server. The
> [`manifest.json`](./manifest.json) here documents the same App and can be used with GitHub's
> *App Manifest* flow instead — but that flow requires a server to exchange the returned `code` for
> the credentials, so it's only for automated/advanced setups, not the manual path above.

- For the **canonical** setup, wire the App ID + key into the broker (`CRABD_APP_ID`,
  `CRABD_APP_PRIVATE_KEY`) — not into consumer repos.
- To **self-host your own App**, store `CRABD_APP_ID` / `CRABD_APP_PRIVATE_KEY` as repo/org secrets.
  The installation ID is auto-resolved from the repository.

## Forgejo

Forgejo has no GitHub App equivalent, so identity there is **whatever bot account's token the
workflow provides** (`CRABD_FORGEJO_TOKEN`). Create a dedicated bot user, its name/avatar become
crab'd's identity. See the Forgejo workflow in [`../workflows/forgejo`](../workflows/forgejo/crabd.yml).

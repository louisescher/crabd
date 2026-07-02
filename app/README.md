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

1. Open [`register.html`](./register.html) (or paste [`manifest.json`](./manifest.json) into GitHub's
   *New GitHub App → from manifest* flow). Optionally enter your org.
2. Create the App. GitHub uses crab'd's name, permissions (`contents`, `issues`, `pull_requests`
   write; `metadata` read), and events (`issue_comment`, `issues`, `pull_request`).
3. Generate a private key and note the App ID.
4. **Install** the App on the repos/org crab'd should act on.

- For the **canonical** setup, wire the App ID + key into the broker (`CRABD_APP_ID`,
  `CRABD_APP_PRIVATE_KEY`) — not into consumer repos.
- To **self-host your own App**, store `CRABD_APP_ID` / `CRABD_APP_PRIVATE_KEY` as repo/org secrets.
  The installation ID is auto-resolved from the repository.

## Forgejo

Forgejo has no GitHub App equivalent, so identity there is **whatever bot account's token the
workflow provides** (`CRABD_FORGEJO_TOKEN`). Create a dedicated bot user, its name/avatar become
crab'd's identity. See the Forgejo workflow in [`../workflows/forgejo`](../workflows/forgejo/crabd.yml).

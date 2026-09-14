---
title: Google (Gemini & Vertex AI)
description: Use Gemini through Google AI or Vertex AI with crab'd.
---

Gemini is available two ways: through **Google AI** (`google`, an API key) or through **Vertex AI /
Agent Platform** (`google-vertex`, Application Default Credentials). Pick whichever matches how your
org buys Google models.

## Google AI (Gemini API key)

The quickest path: a single API key.

1. Create a key in [Google AI Studio](https://aistudio.google.com/apikey).
2. Store it as `GEMINI_API_KEY`.

```yaml title=".crabd.yml"
model: google/gemini-2.5-pro
providers:
  allowlist: [google]
```

```yaml title="workflow"
- uses: louisescher/crabd@v0
  with:
    model: google/gemini-2.5-pro
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

## Vertex AI / Agent Platform

Use `google-vertex` when you want Gemini billed and governed through Google Cloud. It authenticates
with **Application Default Credentials**, a service-account key the runner can read.

1. Set up [Workload Identity Federation](https://github.com/google-github-actions/auth#preferred-direct-workload-identity-federation)
   for the repository, so the runner gets a short-lived token and there's no key to leak.
2. Provide the ADC file path and your project/location via env.

```yaml title=".crabd.yml"
model: google-vertex/gemini-2.5-pro
providers:
  allowlist: [google-vertex]
```

```yaml title="workflow"
- uses: google-github-actions/auth@v2
  id: auth
  with:
    workload_identity_provider: projects/123/locations/global/workloadIdentityPools/gh/providers/gh
    service_account: crabd@my-gcp-project.iam.gserviceaccount.com
- uses: louisescher/crabd@v0
  with:
    model: google-vertex/gemini-2.5-pro
  env:
    GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.auth.outputs.credentials_file_path }}
    GOOGLE_CLOUD_PROJECT: my-gcp-project
    GOOGLE_CLOUD_LOCATION: us-central1
```

:::caution
`google-github-actions/auth` writes its credentials file into `$GITHUB_WORKSPACE`, which is the
repository checkout the agent works in. Add `gha-creds-*.json` to your `.gitignore`.

crab'd drops that file from every commit, whatever the baseline says about it, and refuses a commit
that carries any other untracked path shaped like a credential. Treat both as the last line rather
than the plan: a key you never download is a key that can't be committed, which is why the steps
above use federation over `credentials_json`.
:::

:::note
`google` and `google-vertex` are distinct provider IDs — allowlist whichever you use, and match it in
your model specifier.
:::

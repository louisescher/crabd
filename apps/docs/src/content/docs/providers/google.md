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
- uses: louisescher/crabd@v1
  with:
    model: google/gemini-2.5-pro
  env:
    GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}
```

## Vertex AI / Agent Platform

Use `google-vertex` when you want Gemini billed and governed through Google Cloud. It authenticates
with **Application Default Credentials**, a service-account key the runner can read.

1. Create a service account with Vertex AI access and download its JSON key (or use
   [`google-github-actions/auth`](https://github.com/google-github-actions/auth) to provide ADC).
2. Provide the ADC file path and your project/location via env.

```yaml title=".crabd.yml"
model: google-vertex/gemini-2.5-pro
providers:
  allowlist: [google-vertex]
```

```yaml title="workflow"
- uses: google-github-actions/auth@v2
  with:
    credentials_json: ${{ secrets.GCP_SA_KEY }}
- uses: louisescher/crabd@v1
  with:
    model: google-vertex/gemini-2.5-pro
  env:
    GOOGLE_APPLICATION_CREDENTIALS: ${{ steps.auth.outputs.credentials_file_path }}
    GOOGLE_CLOUD_PROJECT: my-gcp-project
    GOOGLE_CLOUD_LOCATION: us-central1
```

:::note
`google` and `google-vertex` are distinct provider IDs — allowlist whichever you use, and match it in
your model specifier.
:::

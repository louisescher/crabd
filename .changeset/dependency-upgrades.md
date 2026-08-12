---
"@crabd/config": patch
"@crabd/core": patch
"@crabd/broker": patch
"@crabd/action": patch
---

Upgrade dependencies: js-yaml 5, jose 6, `@octokit/rest` 22, `@octokit/auth-app` 8, `@hono/node-server` 2, `@types/node` 26, TypeScript 7 (packages only), plus hono, vitest, tsdown, astro and starlight minors.

js-yaml 5 drops its default export and now throws on a document with no content instead of returning nothing. `parseConfigYaml` keeps its documented contract: a `.crabd.yml` that is blank or all comments still resolves to an empty partial rather than failing the run.

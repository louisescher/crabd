---
'@crabd/core': minor
'@crabd/config': minor
'@crabd/action': minor
---

Fixes a `.crabd.yml` on a pull request head being able to set the permissions of the run reviewing it. `permissions.*`, `governance.*` and `prompt.override` are read from the repository's default branch. Everything else, `implement.verify.commands` included, still comes from the checkout. A permissions change on the default branch now applies to pull requests that are already open.

Fixes Vertex rate limits reported as `RESOURCE_EXHAUSTED` being treated as fatal, which meant `rate_limit.fallback_models` never engaged.

Improves what a failed secret scan tells you. A scan that times out is retried once, then reported as a timeout with the file count and the limit. A missing gitleaks binary is reported as a packaging problem. The default timeout is 120 seconds, and the commit is refused in both cases.

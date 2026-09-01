---
"@crabd/core": minor
"@crabd/config": minor
"@crabd/action": minor
---

Scan every commit and memory write for secrets with gitleaks before it reaches the forge, blocking the write on a finding. New `permissions.secret_scan` config field, on by default.

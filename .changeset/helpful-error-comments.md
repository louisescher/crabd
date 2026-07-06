---
"@crabd/core": minor
"@crabd/action": minor
---

Helpful failure comments, a graceful landing at the turn limit, and a scoped-environment prompt.

- **Every error crab'd posts is now actionable.** A new `renderFailure` replaces the raw
  code-fenced stack trace with a tailored comment per failure kind (`max_turns`, `timeout`,
  `config`, `network`, generic) — each explains what happened, names the exact config knob to
  change (e.g. `limits.max_turns`, `limits.timeout_minutes`), and links a new
  [Troubleshooting](https://crabd.lou.gg/troubleshooting/) page. The model turn returns fatal
  failures (max_turns, timeout, …) as structured results instead of throwing, and the hard-crash
  path no longer leaks the subprocess command line / serialized prompt into the comment.
- **Graceful landing at the turn limit.** crab'd reserves a few turns near the ceiling to ask the
  model for a best-effort final answer, so a run that hits `limits.max_turns` posts a useful partial
  result (marked as partial) instead of aborting with no output. Fully best-effort — it degrades to
  the helpful max_turns comment if a wrap-up can't be produced.
- **Scoped-environment prompt.** The built-in base prompts now tell the agent it works in a single,
  repository-scoped checkout, so it doesn't burn its budget looping on cross-repo files or CI it
  can't access. (Skipped when the prompt is fully overridden.)

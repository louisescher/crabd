---
'@crabd/config': minor
'@crabd/core': minor
'@crabd/action': minor
---

Substantially rework PR review to cut false positives and catch more real bugs.

**Fixes a correctness bug first.** `pullRequest.headSha` was fetched but never used, and the shipped
workflow templates checked out without an explicit `ref:`. On the `issue_comment` trigger — the main
"@crabd review this" path — that left the runner on the base branch, so every file the agent opened
was the wrong version while the diff in its prompt described the pull request. crab'd now compares
the checkout against the PR head, moves onto it when it safely can (never touching a dirty tree), and
otherwise tells the model outright that the files on disk are not the change under review. The
workflow templates pass an explicit `ref:` for comment triggers.

**The review prompt** grew from four lines into a structured one: the job is framed as finding where
the change breaks rather than describing it, the model's own rationalisations are named and rebutted,
and a phased method requires opening the real files and grepping for callers before judging anything.
Findings must pass a refutation checklist (already handled / intentional / not actionable), and a
built-in list of never-report classes and settled precedents replaces the previous lone strictness
adjective. Reporting nothing is now explicitly a good outcome — the old level 3–5 guidance told the
model to keep looking until it found something, which is an instruction to pad.

**Findings are now checkable.** `ReviewOutputSchema` gains `severity`, `category`, `confidence`,
`shortSummary`, `failureScenario`, `evidence`, and `recommendation` alongside the existing
`path`/`line`/`body`, which are unchanged. `failureScenario` is required: a finding that cannot name
concrete inputs *and* the concrete wrong result cannot be serialised, which is exactly the shape a
pattern-matched false positive takes. Gates then run in code, where the model cannot argue with them:
sub-threshold findings are dropped, an `evidence.quote` that does not appear in the file it cites is
discarded as a fabricated citation, findings are ranked by severity then confidence and capped, and
crab'd will not approve while a blocking finding stands.

**Anchoring is fixed.** The prompt now lists the exact lines a forge will accept an inline comment on
and ships the changed files' line-numbered contents from HEAD, so the model copies coordinates
instead of deriving them from a hunk header. A finding that still misses by a few lines is snapped
onto the nearest legal line (noting the line it meant) rather than demoted to body text, and one that
misses badly earns a bounded self-correction turn on the same session.

**New config**, all under `review`: `min_confidence`, `max_findings`, and `dimensions` (each derived
from `strictness` unless set), plus `exclusions` and `precedents`, which **accumulate** across config
layers so an org can pin house rules and a repo can retire its own recurring false positives for
good. `review.verify` adds an opt-in second pass that sends each candidate finding to an independent,
blinded refuter and posts only what survives — the strongest lever on false positives, off by default
because it costs an extra model call per finding.

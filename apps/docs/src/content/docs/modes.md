---
title: Modes
description: How mention, review, and implement behave — and how mentions steer them.
---

crab'd runs in one **mode** per event. Three are built in, though you can add your own (see
[Custom modes](/custom-modes/)). Every mode receives any text you write after the mention, so a
comment can always steer the run.

## mention

**Triggered by** a comment containing your trigger phrase (default `/crabd`).

crab'd answers the request. If it edits files in the checked-out repo, it commits them to a branch
and notes the branch in its reply.

```text
/crabd why is the retry logic firing twice here?
/crabd add a unit test for the empty-input case
```

## review

**Triggered by** a pull request being opened, reopened, or marked ready for review, **not** on every
push to the PR. To re-review after changes, comment `/crabd review`.

crab'd reads the diff and posts a review: a summary, a verdict (`APPROVE`, `COMMENT`, or
`REQUEST_CHANGES`), and inline findings anchored to file and line.

```text
/crabd Please review. Focus on the migration and error handling.
```

## implement

**Triggered by** an issue being assigned or labeled, or by a comment like `/crabd implement`.

crab'd plans the change, edits the repo, commits to a branch, and opens a pull request whose title
and body it writes.

## Steering with post-mention text

Whatever follows the mention (and any mode keyword) is threaded into the run as an explicit
instruction. This works for every mode:

| Comment | Mode | Instruction passed to the agent |
| --- | --- | --- |
| `/crabd explain this function` | mention | `explain this function` |
| `/crabd review focus on tests` | review | `focus on tests` |
| `/crabd implement use the new API` | implement | `use the new API` |

## Enabling and disabling modes

Turn any mode off in `.crabd.yml`:

```yaml title=".crabd.yml"
modes:
  implement:
    enabled: false
```

A disabled mode never triggers, even if its keyword appears in a mention.

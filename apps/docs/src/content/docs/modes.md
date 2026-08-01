---
title: Modes
description: How mention, review, and implement behave — and how mentions steer them.
---

crab'd runs in one **mode** per event. Three are built in, though you can add your own (see
[Custom modes](/custom-modes/)). Every mode receives any text you write after the mention, so a
comment can always steer the run.

## mention

**Triggered by** a comment containing your trigger phrase (default `/crabd`).

crab'd answers the request. When the comment **asks for a change**, it makes the change, commits it
to a branch, and notes the branch in its reply.

```text
/crabd why is the retry logic firing twice here?   # answered, nothing committed
/crabd add a unit test for the empty-input case    # implemented and committed
```

A mention that asks for nothing never produces a commit. A bare `/crabd`, or a question, gets an
answer: crab'd will not decide on its own that a fix it noticed is worth pushing to your branch. If
it edited files anyway, it says so and leaves them uncommitted. To get the change, ask for it.

## review

**Triggered by** a pull request being opened, reopened, or marked ready for review, **not** on every
push to the PR. To re-review after changes, comment `/crabd review`.

crab'd reads the diff and posts a review: a summary, inline findings anchored to file and line, and a
plain-language verdict (**Good to merge (LGTM)**, **Nits found**, or **Please address the findings
before merging**, mapping to approve / comment / request-changes).

```text
/crabd Please review. Focus on the migration and error handling.
```

To keep crab'd from formally approving or blocking PRs, set `review.comment_only: true`. It then
always posts a plain comment while still showing the verdict in the summary:

```yaml title=".crabd.yml"
review:
  comment_only: true
```

If crab'd calls PRs clean too readily, turn up `review.strictness` (a `1`–`5` scale, default `2`).
It lowers the confidence a finding needs and widens the set of dimensions reviewed. `1` flags only
merge-blocking correctness and security issues; `4` - `5` review everything.

```yaml title=".crabd.yml"
review:
  strictness: 4
```

If the opposite is true and reviews are noisy, you have three levers, in order of bluntness:

```yaml title=".crabd.yml"
review:
  strictness: 1 # raise the confidence bar, narrow the dimensions
  exclusions:
    - Never comment on the generated client in src/api/generated/.
  verify:
    enabled: true # have a blinded second pass try to refute each finding
```

`exclusions` accumulate across config layers, so retiring a recurring false positive is permanent
rather than something you re-argue on every PR. `verify` is the strongest lever but costs an extra
model call per candidate finding. See the [config reference](/reference/config-yaml/#review) for all
of it.

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

Disabling `implement` also turns writes off everywhere, `mention` included: it is the only mode
whose whole purpose is changing the repo, so switching it off is read as "crab'd does not write
here" rather than "close one of the two ways it writes". If you want mention commits without the
pull-request flow, say so:

```yaml title=".crabd.yml"
modes:
  implement:
    enabled: false
permissions:
  write: true # keep mention's commits
```

See [`permissions.write`](/reference/config-yaml/#permissions) for read-only runs in general.

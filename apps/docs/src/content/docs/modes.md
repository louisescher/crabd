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
push to the PR. Draft pull requests are never reviewed automatically: the review runs once the PR is
marked ready for review. To review a draft anyway, or to re-review after changes, comment
`/crabd review`.

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

This mode has two phases. On an issue it writes the change and opens a pull request. On a pull
request it works a **feedback round**: it reads the open review conversations, makes the change,
commits onto that pull request's branch, and answers every conversation it saw.

### From an issue

**Triggered by** an issue being assigned or labeled, or by a comment like `/crabd implement`.

crab'd plans the change, edits the repo, commits to a branch named `crabd/...`, and opens a pull
request whose title and body it writes. The description carries a hidden marker, which is how later
runs know the pull request is crab'd's own.

### A feedback round

**Triggered by** a submitted review or an inline review comment on a pull request crab'd opened, or
by a comment like `/crabd implement address the review` on any pull request crab'd can write to.

A round sees everything that is open, not just the comment that triggered it: every unresolved
review conversation, the bodies of the submitted reviews, and the failing checks on the head commit
with a tail of their logs. crab'd then commits one change onto the existing branch and accounts for
each conversation with one of six outcomes:

- **fixed**: the code changed in this commit.
- **already fixed**: the code already did this, or an earlier commit handled it.
- **partly done**: some of it is done, and the rest is explained.
- **declined**: deliberately not doing it, with a reason.
- **answered**: it was a question, and here is the answer.
- **needs clarification**: crab'd could not act without knowing something.

crab'd is told it may push back. A reviewer can be wrong about the code, and a round that complies
anyway makes the pull request worse. It declines only with a reason: the comment is wrong about what
the code does, the change would break a named caller or contract, or it is outside what this pull
request is for. Style and naming preferences are not grounds to decline.

A round never retitles the pull request, never creates a second branch, and never rewrites history.

### What each forge can do

| | GitHub | Forgejo v16 |
| --- | --- | --- |
| Round from a comment mention | yes | yes |
| Round from a submitted review | yes | no such trigger event |
| Round from an inline review comment | yes | no such trigger event |
| Reply inside each conversation | yes | one summary comment instead |
| Resolve the conversations it fixed | yes | no API for it |
| Read the failing checks and their logs | yes | yes |

Forgejo Actions has no `pull_request_review` or `pull_request_review_comment` trigger, so a review
submitted on Forgejo cannot start a run. Comment `/crabd implement address the review` instead. The
round then reads the same conversations and does the same work. Its replies arrive as one comment
listing each conversation and its outcome, because the Forgejo API cannot post inside a
conversation or resolve one.

### Verifying a change

Name the commands that decide whether a change is sound, and crab'd runs them before it answers and
reports each one:

```yaml title=".crabd.yml"
implement:
  verify:
    commands:
      - pnpm typecheck
      - pnpm test
```

A failure is disclosed on the pull request and does not block the commit. The checks on the pull
request are the gate that does. These commands accumulate across config layers, so a command an
organization pins cannot be dropped by a repository.

### Fork pull requests

crab'd cannot write to a branch in another repository, so a round on a fork pull request commits
nothing. It posts its answer and lists the files it would have changed, for you to apply.

### Turning rounds off

Rounds are on by default. Switch off the automatic triggers and keep the mention:

```yaml title=".crabd.yml"
implement:
  rounds:
    enabled: false
```

See the [config reference](/reference/config-yaml/#implement) for the rest of the block.

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

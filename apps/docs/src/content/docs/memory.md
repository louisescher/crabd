---
title: Memory
description: How crab'd remembers corrections between runs, and how you manage what it remembers.
---

Correct crab'd on a pull request and, by default, the correction dies with the CI job. Every run
starts from nothing. Memory changes that: when a human replies to one of crab'd's comments and tells
it it was wrong, crab'd can record what it learned as a markdown file in your repository, and read
that file back on every future run.

The memories are **plain files you own**. You review them in a pull request, edit them, and delete
the ones you disagree with. There is no hidden state and no database.

Memory is **off by default**. A memory file becomes standing instruction to the agent, so it only
appears once you ask for it.

## Turning it on

```yaml title=".crabd.yml"
memory:
  enabled: true
```

That is enough. Memories are read from `.crabd/memory/` and, when crab'd learns something, recorded
on the branch of the pull request where the correction happened.

## What a memory looks like

```markdown title=".crabd/memory/no-barrel-files.md"
---
name: no-barrel-files
source: https://github.com/acme/app/pull/812#discussion_r123456
recorded: 2026-08-12
---

Don't flag missing `index.ts` barrel exports. This repo imports by full path on purpose.
```

- **`name`** is the identifier, also used as the filename. Recording a memory with an existing name
  replaces it, so a refined correction supersedes the old one instead of accumulating a near-duplicate.
- **`source`** is a permalink to the comment that taught it, so anyone reading the file can see the
  argument behind it.
- **`recorded`** is when it was written. Used for ordering when the caps below apply.
- **The body** is the instruction itself, addressed to crab'd's future self.

Everything except the body is optional. You can write these by hand, and nothing about the format
requires crab'd to have created it.

## How it is used

Every run loads the memory directory and includes it in the system prompt, alongside your
[`AGENTS.md` and skills](/project-context/). They are framed as *settled rulings* for the
repository: crab'd is told not to re-raise a finding a memory rules out, and not to re-argue the
decision. If a memory genuinely contradicts what it sees in the code, it is told to say so rather
than silently ignore it.

Two caps keep the directory from crowding out the diff, since this text is re-sent on every turn of
the agent loop:

- `memory.max_entries` (default `50`), newest first.
- A total budget of 20,000 characters, applied after that.

## When crab'd records one

crab'd does not record memories at its own discretion on every run. Two things must both hold:

1. **The run is a human replying to crab'd.** Either a reply in an inline review thread that crab'd
   started, or a comment on an issue or pull request where crab'd has already spoken.
2. **The correction generalizes.** crab'd is instructed to record only a durable fact about the
   repository, such as a deliberate convention, an intentional pattern, or a project fact that made
   its finding wrong. It is told explicitly *not* to record anything about the pull request in
   front of it.

The first condition is enforced mechanically. The second is a judgement crab'd makes, which is
exactly why the default is to commit memories somewhere you review them.

## Where memories are written

```yaml title=".crabd.yml"
memory:
  enabled: true
  write: branch
```

| `write`  | Behavior                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------- |
| `branch` | **Default.** Commits to the pull request's own branch, so the memory is reviewed with the code that provoked it. |
| `pr`     | Commits to a `crabd/memory` branch and opens a dedicated pull request. Each memory is approved on its own.       |
| `main`   | Commits straight to the default branch. Takes effect immediately, everywhere, with no review in between.         |
| `off`    | Read-only. You author the files, and crab'd only reads them.                                                     |

Two cases resolve differently under `branch`, and crab'd tells you in its comment when they do:

- **No pull request** (a mention on an issue): there is no branch to target, so it falls back to the
  `pr` behavior. It never falls back to the default branch.
- **A fork pull request**: crab'd's token is scoped to your repository and cannot push to a
  contributor's fork, so the memory is skipped with an explanation. Use `write: pr` if you want
  corrections from fork contributors recorded.

:::caution[`write: main` has no review step]
Under `branch` and `pr`, a memory you disagree with dies by not being merged. Under `main` there is
no such backstop: any comment from someone allowed to trigger crab'd can become standing instruction
to the agent on the next run. Choose it deliberately, and consider locking it from an org config.
:::

## Managing memories

They are files in git, so the usual tools work:

- **Edit** one to sharpen it. crab'd reads whatever is there.
- **Delete** one to make crab'd forget. The next run will raise the finding again.
- **Revert** the commit that added a bad one.
- **Write your own** without waiting for a correction. A hand-authored memory is indistinguishable
  from a recorded one. With `write: off` this is the only way they appear, which is a reasonable
  setup for a repo that wants curated memory and no agent writes.

## If nothing is being recorded

crab'd posts a warning on its tracking comment from the moment it starts, not at the end, when
memory is on but it cannot write. The common causes:

- `permissions.write` is `false`. Memory needs to commit.
- crab'd's token or GitHub App installation lacks `contents: write` for the repository.
- The trigger was a fork pull request under `write: branch`.

When any of these apply, crab'd does not attempt the write at all: it finishes the review normally
and simply doesn't record. No memory is silently lost to a failed commit.

If there's no warning and still nothing is recorded, the run most likely wasn't a reply to crab'd,
or it judged the correction too specific to generalize. Both are working as intended.

## Governance

`memory.enabled` and `memory.write` are both lockable from an org config, like any other key:

```yaml title="org .crabd.yml"
memory:
  enabled: true
  write: pr
governance:
  locked: ['memory.enabled', 'memory.write']
```

See [config layering](/config-layering/) for how that resolves.

---
"@crabd/core": minor
"@crabd/action": minor
---

Report a run that runs out of memory instead of letting the process crash silently.

A turn's own context and tool output can grow without bound between tool calls, so the existing `limits.max_turns` ceiling never catches it: a runaway turn could climb straight to a V8 out-of-memory crash, which kills the process outright rather than rejecting a promise. That left the tracking comment stuck on "working..." forever, with nothing in the log beyond V8's own stack dump. A watchdog now samples heap usage while a turn runs and aborts the attempt itself well before the crash, reporting a new `resource_exhausted` failure kind with a tailored comment instead.

The `remember` tool now logs every memory it records or fails to record, by name and size, so a run that touches memory leaves an actual trail of what happened.

Recorded memories get their own tracking comment instead of riding along on the pinned one. A memory note used to be folded into the same comment as the mode's actual answer, competing for space and resetting on every run. It now posts to (and updates) a dedicated sticky comment, found by its own hidden marker, so a later run's memory note updates in place rather than piling onto the main result.

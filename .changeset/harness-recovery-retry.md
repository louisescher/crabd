---
"@crabd/action": patch
---

Re-run a turn whose harness lost the conversation, instead of throwing the finished work away.

When a model call fails transiently, Flue retries it by resuming the conversation it already has. If that conversation's tail projects to an assistant message, pi-agent-core's `continue()` refuses to resume and rejects with `Cannot continue from message role: assistant`. crab'd read that as a fatal error, so it skipped the fallback chain entirely and failed the check, discarding a review that was minutes of work and seconds from being submitted. Such a failure is now retried once on a fresh instance, which starts from an empty conversation and so cannot inherit the tail that caused it. A deliberate `max_turns` abort is untouched: it must not buy a second full turn.

A transient model retry now also records the provider's own error. Flue reports the failure it is retrying on the log event's attributes and prints only the message, so a run's entire account of why the model failed was the words "Retrying transient model error". Beyond leaving the run undiagnosable, it also cost the fallback chain the one string it could have classified when the retry then failed opaquely.

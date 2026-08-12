---
"@crabd/config": minor
"@crabd/action": major
---

Migrate to Flue 2 and run the agent in-process.

Flue 2 removes `defineWorkflow`, `defineAgent`'s config bag, `flue build`, and the auto-mounted router, so crab'd's two workflows are now agent functions (`src/agents/`) driven by `start()` plus `init()/dispatch()/read()` from the CLI itself. The `flue run` subprocess, its stdout JSON protocol with a 64 MB buffer, `app.ts`, `flue.config.ts`, and the `@flue/cli` dependency are all gone; the image builds one tsdown bundle.

Orchestration that used to live inside the workflow body now lives in `src/turn-runner.ts`, because an agent in v2 is one addressable conversation: the rate-limit fallback chain opens a fresh instance per attempt (preserving the clean-context retry that `harness.session()` gave), the repair pass dispatches to the same instance so it keeps what it read, and the verify stage addresses one refuter instance per finding instead of delegating. v2 delegation is model-driven through the `task` tool, which could not have kept that fan-out deterministic.

Two guarantees the framework used to provide are now explicit: the turn budget (v2 enforces no step cap) counts tool starts and stops applying once the wrap-up is in flight, so a run that exhausts its budget still returns a partial answer; and the mode's output schema is enforced by a terminal `submit` tool with a stated directive and a bounded nudge, replacing the `result` option's built-in re-prompt loop.

Custom providers are now real pi-ai providers built from config rather than flue registrations, which is what makes the new `providers.custom[].reasoning` and `providers.custom[].vision` fields possible — flue's registration surface could not express either at any version, so a self-hosted reasoning model silently received no thinking controls and images sent to a self-hosted vision model were silently replaced with an `(image omitted)` placeholder.

The rate-limit fallback chain needed rescuing: `handle.read()` rejects with an `AgentRunError` carrying only `{ outcome, submissionId }`, so classifying the rejection saw no status code, called every rate limit fatal, and never switched models. The provider's status is captured from the runtime event stream instead (`operation` and `submission_settled` carry it; a failed `turn` event reports `isError` with a null `error`).

Per-run configuration is passed as values through a run context instead of ~20 `CRABD_*` env vars, which only existed to cross the process boundary.

`providers.custom[].base_url` is now optional per layer (a higher layer can override one field), and `resolveConfig` throws when no layer supplied one.

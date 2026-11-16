# Phase 1 local chat verification

Phase 1 acceptance criteria are checked in [the implementation plan](../plans/time-aware-research-agent.md#phase-1-local-chat-that-survives-restart). This report records the current local evidence and its boundaries.

## Evidence

- The application starts with `npm install` and `npm run dev` when dependencies and gateway configuration are present. A temporary isolated-data smoke run with an unavailable gateway returned `/health/live` 200 and `/health/ready` 503 with an actionable error; it made no provider call.
- `npm run test:browser` and `npm run test:research-browser` exercise the real browser/API/persistence path with deterministic fixtures. The latter includes restart and historical source inspection; neither substitutes fixtures into the application runtime.
- The bounded `verify-chat.mjs` browser/HTTP checks on 2026-11-15 exercised the local LiteLLM/Bedrock route, streaming, terminal publication, and restart recovery. These are billable single-turn diagnostics, not quality tests or latency guarantees.
- `npm test` — 29 files, 148 tests passed in the current checkout; `npm run typecheck` passed. The suite covers owner checks, idempotency, one-active-turn behavior, persistence, bounded input, cancellation, failure redaction, and telemetry failure isolation.
- The LangSmith client contract test checks trace ID correlation and redacted content using a recorded HTTP boundary. Exporter failure does not fail the user turn. A live LangSmith account export was not attempted.

The local database and dispatcher checks do not establish multi-process PostgreSQL concurrency. Current provider charges for historical live diagnostics were not measured; see [inference verification](INFERENCE_VERIFICATION.md). The release plan remains authoritative for later phase completion.

# Phase 12 local load evaluation

Run: `npm run evaluate:local-load` on 2026-11-16. This is one local synthetic run, not a hosted capacity claim.

## Workload and machine

- Node v22.23.2; AMD Ryzen 5 7530U; 12 logical cores; 16,109,858,816 bytes RAM.
- 100 initial SSE clients across 10 simultaneously active turns; configured concurrency limit 10; then 100 reconnect clients.
- 250 historical exchanges (15,784 bytes); 55-byte request; 33,120 generated delta bytes per successful turn.
- Cold process caches; no search cache. Synthetic workers and deterministic embeddings; zero external model calls and $0.00 provider cost.
- One deliberately injected dependency outage; 9 completed and 1 failed; 0 connection errors. A slow reader received the canonical completion event. Indexing completed 259 messages, with no pending backlog; indexing elapsed 3,533.73 ms.

## Observed latency

Milliseconds, measured from each API admission or run start; completion percentiles include the nine successful runs only.

| Measure | p50 | p95 | Samples |
| --- | ---: | ---: | ---: |
| Admission acknowledgement | 58.77 | 63.79 | 10 |
| First streamed answer | 1,705.01 | 2,029.69 | 9 |
| Successful completion | 2,302.36 | 2,517.53 | 9 |

The reconnect burst completed in 615.52 ms; initial worker wall time after release was 532.73 ms. These timings include the local fixture's scheduling and streaming behavior and do not estimate model quality, provider cost, network latency, or multi-process capacity.

## Coverage limits

Slow-consumer delivery, reconnect replay, concurrent indexing, and a dependency failure are covered in this workload. Process-crash recovery remains covered by separate persistence tests, not this in-memory run. This is a baseline observation, not a regression threshold; numeric gates require a reviewed repeatable baseline and a separate bounded live-provider evaluation.

## Assignment browser scenarios

`npm run test:research-browser` runs the three problem-statement scenarios in the actual browser UI against a separate temporary PGlite database and a deterministic gateway/search fixture:

- The Monday CRM question recovers the original five named products and cites current fixture evidence for each. The original answer has no stored source observations, so the UI reports `historical_support_missing` instead of asserting a price or feature change.
- The 3 November question opens the source discussion with the original Postgres question and answer, verifies current Neon and Supabase evidence, and leaves historical correctness unresolved because no observations were attached then.
- The last-Tuesday Postgres question retrieves its intended discussion, cites the current Neon and Supabase fixture observations, and labels the earlier price baseline unsupported.

These tests verify retrieval, evidence linking, and honest comparison behavior. The generated prices, releases, and search observations are fixtures; they are not live provider research or claims about current vendor offerings.

## Reproduction checks

- `npm run typecheck` — passed.
- `npm test` — 29 files, 148 tests passed. The suite includes ownership isolation, invalid and cross-run citation rejection, concurrent duplicate-publication protection, incompatible-vector filtering, required-subject coverage, recall deletion races, and process-restart recovery.
- `npm run test:research-browser` — passed, including the three assignment scenarios above and the existing source-inspection/restart/continuation flow.
- Startup smoke check with isolated temporary storage and an intentionally unavailable local gateway — Vite and the API started; `/health/live` returned 200 and `/health/ready` returned 503 with an actionable “Start the gateway and check INFERENCE_BASE_URL” error. No inference or search call was made.
- Clean-start prerequisites and credentials are documented in [README](../README.md), [.env.example](../.env.example), and [gateway setup](../infra/litellm/README.md). Research fixtures are enabled only by the dedicated browser harness and a separate temporary data directory; the application runtime does not substitute fixtures for a missing provider.
- `tests/tracing.test.ts` verifies the LangSmith client request contract contains redacted inputs/outputs and only lifecycle/budget metadata. `tests/chat.test.ts` verifies turns still complete when the trace exporter throws. A tracked-file scan for common AWS, GitHub, Slack, OpenAI-style tokens and private-key headers returned no matches; this is a pattern check, not a secret scanner. Live LangSmith account export was not attempted.

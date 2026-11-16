# Phase 12 local load evaluation

Runs: `npm run evaluate:local-load` on 2026-11-16. These are four local synthetic runs, not a hosted capacity claim. The process-recovery fixture ran concurrently while the primary workload's 100 SSE clients were attached and 10 turns were held at the dispatcher gate; its service used an independent file-backed store and local gateway fixture.

## Workload and machine

- Node v22.23.2; AMD Ryzen 5 7530U; 12 logical cores; 16,109,858,816 bytes RAM.
- 100 initial SSE clients across 10 simultaneously active turns; configured concurrency limit 10; then 100 reconnect clients.
- 250 historical exchanges (15,784 bytes); 55-byte request; 33,120 generated delta bytes per successful turn.
- Cold process caches; no search cache. Synthetic workers and deterministic embeddings; zero external model calls and $0.00 provider cost.
- One deliberately injected dependency outage; 9 completed and 1 failed; 0 connection errors. A slow reader received the canonical completion event. Indexing completed 259 messages, with no pending backlog; indexing elapsed 6,937.91 ms.

## Observed latency

Milliseconds, measured from each API admission or run start; completion percentiles include the nine successful runs only.

| Run | Admission p50 / p95 (10) | First answer p50 / p95 (9) | Successful completion p50 / p95 (9) |
| --- | ---: | ---: | ---: |
| Initial recorded run | 56.10 / 67.70 | 4,320.41 / 4,814.26 | 6,120.85 / 6,325.56 |
| Repeat 1 | 56.92 / 67.01 | 4,333.78 / 4,780.17 | 6,035.89 / 6,248.13 |
| Repeat 2 | 57.04 / 65.94 | 4,311.71 / 4,702.72 | 6,027.98 / 6,268.89 |
| Repeat 3 | 56.53 / 71.05 | 4,398.88 / 4,770.82 | 6,330.73 / 6,543.92 |

Across the four runs, p95 ranges were 65.94–71.05 ms for admission, 4,702.72–4,814.26 ms for first answer, and 6,248.13–6,543.92 ms for successful completion. A provisional local-only regression tripwire is 86 ms, 5,780 ms, and 7,860 ms respectively (the rounded-up worst observed p95 plus 20%). This is a smoke threshold for this exact synthetic workload and machine, not an SLO or cross-machine guarantee. The crash-fixture startup/recovery overlaps the measured workload and adds interference; re-baseline if the fixture, runtime, or hardware changes. These timings do not estimate model quality, provider cost, network latency, or multi-process capacity.

## Coverage limits

Slow-consumer delivery, reconnect replay, concurrent indexing, a dependency failure, and a hard process crash/restart are covered during these local evaluations. The crash/restart uses a separate file-backed app store and gateway; it does not kill the server handling the 100-client workload or test shared-database multi-process contention. All four samples passed harness acceptance: 100 initial clients, 100 reconnects, 9 successful runs, 1 injected outage, zero connection errors, 259 indexed messages, zero pending backlog, slow-consumer completion, and one recovered logical answer. The deterministic browser quality gate is 3/3 assignment scenarios passing, including all five CRM shortlist subjects with current fixture citations and explicit unsupported-history handling. A separate live batch completed 3/3 scenarios with real search and cited findings, while leaving missing historical baselines unresolved; actual provider billing remains unreconciled. See [the live evaluation report](PHASE12_LIVE_EVALUATION.md) for the human rubric, supplementary judge disagreement, usage totals, and limits.

## Assignment browser scenarios

`npm run test:research-browser` runs the three problem-statement scenarios in the actual browser UI against a separate temporary PGlite database and a deterministic gateway/search fixture:

- The Monday CRM question recovers the original five named products and cites current fixture evidence for each. The original answer has no stored source observations, so the UI reports `historical_support_missing` instead of asserting a price or feature change.
- The 3 November question opens the source discussion with the original Postgres question and answer, verifies current Neon and Supabase evidence, and leaves historical correctness unresolved because no observations were attached then.
- The last-Tuesday Postgres question retrieves its intended discussion, cites the current Neon and Supabase fixture observations, and labels the earlier price baseline unsupported.

These tests verify retrieval, evidence linking, and honest comparison behavior. The generated prices, releases, and search observations are fixtures; they are not live provider research or claims about current vendor offerings. The separate live-provider result is summarized in [the live evaluation report](PHASE12_LIVE_EVALUATION.md).

## Reproduction checks

- `npm run typecheck` — passed.
- `npm test` — 29 files, 153 tests passed. The suite includes ownership isolation, invalid and cross-run citation rejection, concurrent duplicate-publication protection, incompatible-vector filtering, required-subject coverage, recall deletion races, process-restart recovery, and fallback capability rejection/readiness/rebudgeting under a mock gateway.
- `npm run test:research-browser` — passed, including the three assignment scenarios above and the existing source-inspection/restart/continuation flow.
- Startup smoke check with isolated temporary storage and an intentionally unavailable local gateway — Vite and the API started; `/health/live` returned 200 and `/health/ready` returned 503 with an actionable “Start the gateway and check INFERENCE_BASE_URL” error. No inference or search call was made.
- Clean-start prerequisites and credentials are documented in [README](../README.md), [.env.example](../.env.example), and [gateway setup](../infra/litellm/README.md). Research fixtures are enabled only by the dedicated browser harness and a separate temporary data directory; the application runtime does not substitute fixtures for a missing provider.
- `tests/tracing.test.ts` verifies the LangSmith client request contract contains redacted inputs/outputs and only lifecycle/budget metadata. `tests/chat.test.ts` verifies turns still complete when the trace exporter throws. A tracked-file scan for common AWS, GitHub, Slack, OpenAI-style tokens and private-key headers returned no matches; this is a pattern check, not a secret scanner. Live LangSmith account export was not attempted.

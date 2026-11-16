# Phase 2 research verification

Phase 2 acceptance criteria are checked in [the implementation plan](../plans/time-aware-research-agent.md#phase-2-research-with-inspectable-citations). The evidence combines deterministic tests, a browser workflow, and one bounded real-gateway compatibility check; it does not establish broad model or vendor-search quality.

## Local behavior

`npm run test:research-browser` runs the real UI, API, persisted LangGraph workflow, PGlite storage, and deterministic gateway/search fixtures. It verifies progress before publication, citation/source inspection after restart, safe rendering of hostile snippets, historical and user-reported comparisons, paraphrased recall, timeout partial source observations and linked continuation, and the three hiring-challenge scenarios. Those scenarios use a separate temporary database. Their products, prices, release notes, and search observations are synthetic; missing historical source observations are disclosed as unsupported baselines.

`npm test` covers registered citation ownership, malformed tool responses, prompt-injection text, unavailable search, price qualification, freshness/cache behavior, and durable source provenance. The full current suite is recorded in [Phase 12 local evaluation](PHASE12_LOCAL_EVALUATION.md).

## Bounded live compatibility

On 2026-11-15, `node --import tsx scripts/verify-research.mjs` sent two model calls through local LiteLLM to the configured Bedrock Nova model, with a synthetic search result. The model requested the sole `web_search` tool, continued with its tool result, and returned a citation that passed run-scoped validation. This confirms one live client/tool-result path under that model and configuration. It does not verify the live Tavily service, model quality across the assignment scenarios, or general schema reliability. The diagnostic's exact provider charge was not measured; see [inference verification](INFERENCE_VERIFICATION.md).

Ordinary search may reuse same-owner cached evidence for five minutes with the original observation timestamp. Explicit fresh verification bypasses cache. No direct web-page fetching is enabled. Real-world source support and significance judgments still require a separately budgeted quality evaluation.

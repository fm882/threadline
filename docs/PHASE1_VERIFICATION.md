# Phase 1 verification in progress

On 2026-11-15, the application `gatewayClient` sent one synthetic request through the local LiteLLM `chat-main-v1` route to the configured Bedrock Nova Pro baseline. The response matched the requested phrase and arrived in six nonempty chunks. The request used the application's 1,024-token maximum, no retries, and a 60-second deadline. This is a connectivity and streaming check, not a model-quality evaluation or an end-to-end browser demonstration. It can incur provider charges.

The automated suite uses real PGlite persistence and recorded or local synthetic provider responses. `npm test` checks owner isolation, admission idempotency, single publication, fixed cutoff, failure redaction, restart persistence, the gateway streaming contract and trace failure isolation. `npm run typecheck` checks TypeScript. These do not establish all Phase 1 acceptance criteria; the plan remains authoritative.

The live readiness endpoint returned HTTP 200 with the configured local gateway running and HTTP 503 with an actionable error after it stopped. The cutoff and concurrent active-turn checks use local PGlite; they do not prove multi-process PostgreSQL concurrency. LangSmith is not configured in this environment, so no live trace export has been verified.

On 2026-11-15, `node scripts/verify-chat.mjs` also completed one synthetic turn through the HTTP API, graph, LangChain client, local LiteLLM and configured Bedrock route. It observed streamed deltas and the terminal event, restarted the server, and verified the saved exchange. Start the gateway first; this check makes a billable provider request and uses a temporary isolated application database. It does not exercise a browser.

The trace integration test runs a synthetic turn through the real LangSmith client with a recorded HTTP boundary. It verifies run-ID correlation, admission/inference/publication stages, content redaction, and failure isolation. No live LangSmith account export has been verified.

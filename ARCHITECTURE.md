# Time-Aware Research Agent: architecture decision

Status: architecture C accepted. Revised to use LangGraph, LangChain, and LangSmith, with hybrid temporal/semantic retrieval and explicit context budgeting. No application has been implemented or benchmarked yet.

## Decision

Build a TypeScript modular monolith with one model-visible tool, web_search. Prepare a durable historical-context snapshot per admitted turn through TurnHistory.prepare(turn). Hide replaceable retrieval strategies inside this module. Original messages and stored source evidence remain authoritative; normalized claims are derived interpretations.

Deep modules: turn execution and recovery; historical context preparation; search evidence acquisition; evidence-backed answer publication. Infrastructure adapters implement the dependencies of these modules rather than owning business rules.

## Recommended stack and alternatives

| Area | Baseline | Alternative and trigger |
| --- | --- | --- |
| Runtime | Node 24 LTS, strict TypeScript, npm lockfile | Another supported LTS after dependency and CI validation |
| HTTP | Hono with Node adapter; SSE | Fastify if richer server plugin conventions become useful |
| UI | React + Vite, plain CSS initially | Next.js if server-rendered product pages become a real requirement |
| Contracts | Zod at external boundaries | Handwritten validation only for truly trivial internal structures |
| Model access | LangChain chat-model integrations and initChatModel | Provider-specific options remain capability-tested; no second AI SDK abstraction |
| Agent control | LangGraph StateGraph with bounded research node/subgraph | LangChain createAgent inside research when its middleware fits; domain nodes remain explicit |
| Models | Configured strong and fast tiers; select exact IDs by evaluation | Add another provider only after testing its tool and structured-output behavior |
| Local data | File-backed PGlite | SQLite/libSQL if embedded runtime constraints outweigh SQL parity |
| Production data | Managed PostgreSQL + pgvector | Separate vector service only after measured database constraints |
| SQL/schema | Drizzle with reviewed SQL migrations; explicit SQL for retrieval and concurrency | Direct parameterized SQL if ORM abstraction adds no value |
| Dates | chrono-node for candidate expressions; explicit timezone/calendar policy | Add a timezone library if required by calendar arithmetic; parser defaults never define product policy |
| Search | Tavily adapter, official-source preference | Evaluate Exa/Brave on the same fixtures before selecting fallback |
| Retrieval | Temporal SQL + full-text + embedding candidates, rank fusion, Cohere reranking through LangChain | Skip semantic/reranking path for explicit IDs or exhaustive date recall; degrade to lexical with reported coverage |
| Embeddings | LangChain Embeddings integration, initially OpenAIEmbeddings; versioned model and dimensions | Another embedding provider requires re-embedding into a separate index generation |
| Context control | LangChain trimming/summarization primitives with application-owned evidence priorities | Built-in agent middleware applies inside createAgent, not automatically to arbitrary graph nodes |
| Checkpoints | Official SQLite checkpointer locally; official PostgreSQL checkpointer in production | Do not assume the PostgreSQL checkpointer works directly with embedded PGlite |
| Telemetry | LangSmith for agent traces/evaluations; OpenTelemetry for operational metrics/traces; Pino logs | No Langfuse; configure correlation and avoid duplicate instrumentation |
| Jobs | Durable database job table; worker loop in same local process | Separate worker process from the same codebase in production |
| Tests | Vitest boundary tests, Playwright browser flows, k6 load tests | Provider integration smoke tests supplement recorded fixtures |
| Hosting | Containerized always-on Node service + managed PostgreSQL | Separate worker and coordinated distributed limits when scaling replicas |

PGlite reduces dialect differences but does not reproduce production connection concurrency, networking, failover, or all extensions. Run concurrency and adapter-contract tests against real PostgreSQL. Driver substitution is not automatic data migration.

Local setup now has two persistence roles: PGlite owns application records/vector retrieval, and the packaged SQLite checkpointer owns graph recovery state. This avoids writing a custom checkpointer. Production puts both roles in PostgreSQL with separate table ownership. Test cross-store recovery locally; no atomic transaction across application writes and graph checkpoints is assumed.

## Framework responsibilities

Use LangGraph for graph state transitions, checkpointing, branching, streaming, and resumable execution. Use LangChain for model/embedding integrations, tool schemas, retriever/document types, splitting, trimming, and compatible middleware. Use LangSmith for run inspection, evaluation datasets, and experiments. Pin compatible packages and evaluate provider tool/structured-output behavior; a common interface does not imply identical capabilities.

Graph: admitted run -> prepare history -> compile bounded context -> research/tool loop -> validate structured answer -> publish. Ambiguity exits through clarification. Before each model invocation, budget the complete serialized input again. LangChain agent middleware is used only within compatible agent execution; explicit graph nodes call shared utilities directly.

Keep graph state small: IDs of turn/context/evidence, bounded working messages, budgets, and execution status. Store original transcripts and page bodies in the application database, not repeatedly in checkpoint state. A LangGraph checkpoint is execution state; the C snapshot records the historical evidence chosen for a turn. Give each logical research run an authorized graph thread identity and record its checkpoint lineage; conversation continuity comes from TurnHistory. Resume uses the same logical run, and explicit new verification creates a new run.

Framework checkpoints do not provide authorization, exactly-once external calls, job scheduling, or atomic application/checkpoint commits. Persist side effects idempotently and reconcile completion on recovery. A durable worker claims admitted runs and resumes their graphs; do not build a second workflow engine. SDK retry settings and graph retry policies must share a total retry/deadline budget.

## Temporal storage and indexing

PostgreSQL is the temporal source of truth; no separate temporal database is necessary initially. Keep original messages, source-evidence observations, claim versions, chunks, embedding generations, derived summaries, run snapshots, and graph checkpoints as distinct records/roles.

- Messages: owner, conversation, committed ordering, recorded_at, role, original content.
- Evidence observations: URL, captured content/excerpt, content hash, retrieved_at, optional published_at and source-supported effective time, snippet/page representation.
- Claim versions: source message/span, normalized entity/attribute/value/dimensions, recorded_at, optional valid_from/valid_to, evidence links, supersession links, and support/interpretation status.
- Chunks: owner, conversation, parent/message span IDs, time range, text hash, chunker version, text-search index.
- Embeddings: chunk ID, embedding provider/model, dimension, index generation, completion/error status.

Distinguish recorded time (when the system learned something) from valid/effective time (when a claim applied in the world). Effective time is often unknown; never invent it from publication or retrieval time. Preserve corrections and supersession rather than overwriting old assertions. Index owner + message time and owner + entity/attribute; exact date recall uses original records, not vector top-k.

Ingestion persists messages/evidence first and transactionally enqueues derived indexing. Create conversation-aware chunks around exchanges/topic segments; preserve entire lists where possible. Split long segments with LangChain text-splitting primitives, initially targeting roughly 400–800 tokens with modest overlap, retaining exact source spans and parent links. These sizes are tuning hypotheses, not measured optima. Embed batches asynchronously, validate dimensions/finite values/nonzero norms, and expose indexing lag. Recent unindexed originals remain queryable.

Use a pinned embedding configuration and matching query encoder. Never mix vectors from different model versions even when dimensions match. Re-embed in a separate generation and switch after retrieval evaluations pass. Cache embeddings by authorized content identity/hash plus model configuration. Deletion covers chunks, vectors, summaries, snapshots, checkpoints, and exported content according to retention policy.

## Retrieval pipeline

1. Interpret query into discussion reference, possible discussion-time window, comparison interval, entities, scope, and ambiguity. Date parser proposes expressions; application policy determines semantics.
2. Apply authenticated scope and committed history cutoff to every retrieval branch. Exact date-listing queries use paginated original SQL records and coverage accounting, bypassing relevance top-k. Exact message references bypass search.
3. For semantic references, retrieve recent continuity, full-text candidates, vector candidates, and entity/temporal matches. Temporal constraints are hard only when established; recency must not override an explicit historical date. All branches obey the same authorization policy.
4. Fuse ranked lexical/vector lists using reciprocal-rank fusion rather than adding incomparable scores. Deduplicate by source spans/parents. Initial candidate bounds of roughly 30–50 per search branch are tunable workload budgets, not completeness guarantees.
5. Rerank a bounded merged set through LangChain's CohereRerank integration. Include speaker/date/entity metadata. Reranking assesses relevance, not factual support; do not silently discard competing historical interpretations. Skip when deterministic retrieval suffices; on timeout use fused ranking and record degradation.
6. Hydrate selected parent exchanges and neighboring turns, recovering complete shortlists and attached historical evidence. Recheck ownership/cutoff. Initial 6–12 parent candidates are a budget hypothesis, not a universal limit.
7. Resolve references or clarify, then assemble the C snapshot. Preserve originals and provenance, report truncation/index lag, and permit one bounded retrieval expansion when evidence is insufficient.

Use exact vector scans for small authorized candidate sets. Introduce HNSW for larger workloads after measurement. Filtered approximate search can under-return; evaluate iterative scans, oversampling, partitioning, or exact fallback while enforcing tenant filters in SQL. Embeddings are not a replacement for temporal SQL. Page/search-result reranking is a separate invocation over web evidence, not a mixed private-history index.

## Context overflow control

Persisted history can grow independently of model input. Maintain three tiers: raw archive, searchable chunks/derived summaries, and a bounded working context. Summaries aid navigation but are not evidence for exact recall or historical comparisons.

Before every model call, compute input budget = min(configured working ceiling, selected model context limit minus output/reasoning allowance minus safety margin). Count system instructions, current input, schemas/tool definitions, history, selected evidence, tool results, and provider framing. Use model-aware counting where available and conservative estimation otherwise. Model fallback recomputes the budget for its own limits.

Initial illustrative working-input ceiling: 24k tokens, subject to the actual model limit. Example allocation: 3k instructions/schema/current question, 4k recent continuity, 7k historical evidence, 8k current web evidence, 2k working notes. Output and safety reservations are outside this input budget. All figures require evaluation.

Preserve the current question, instructions, unresolved references, minimum evidence for each comparison, and valid tool-call/result pairing. Drop duplicate/low-relevance excerpts first, extract bounded quoted spans next, summarize older continuity last. Use LangChain trimMessages and summarization utilities; keep compressed views separate from original durable records. Avoid recursively treating summaries as primary facts.

If selected evidence is too large, split the comparison by entity into bounded graph tasks producing structured claims with source IDs, then synthesize their results. Keep candidate originals available for rehydration. This is controlled decomposition, not an unconstrained multi-agent team. If required evidence still cannot fit, return an explicit partial result or ask to narrow scope. Never silently drop a shortlisted entity. Handle context-length errors with one bounded recompaction attempt, not identical retries.

## Historical context contract

```ts
interface TurnHistory {
  prepare(turn: AuthorizedTurn, options?: { signal?: AbortSignal }): Promise<HistorySnapshot>;
}

interface HistoryRetriever {
  retrieve(request: RetrievalRequest, options: { signal?: AbortSignal }): Promise<{
    candidates: Array<{ messageId: string; reason: string; score?: number }>;
    coverage: RetrievalCoverage;
  }>;
}
```

AuthorizedTurn is established by admission and checked against current permissions. It fixes run time, timezone, and an account-wide history visibility boundary. Implement that boundary with an explicit committed ordering/watermark protocol; timestamps or a per-conversation sequence alone do not guarantee a stable cross-conversation snapshot.

The history module owns authorization, date interpretation, original-message hydration, reference selection, ambiguity handling, coverage accounting, and snapshot persistence. The retriever proposes candidates; it cannot declare history authoritative or authorize access. Hydration rechecks ownership and the cutoff.

Results distinguish resolved, clarification_needed, no_match, incomplete, and not_needed. No match is scoped to successful retrieval coverage. Retrieval limits, retention gaps, or backend failures must not become claims that history does not exist.

Keep discussion dates separate from comparison intervals: “changed since Monday” does not imply that the shortlist was discussed Monday. Anchor relative language in the current turn to its fixed clock; historical quotations retain their original temporal context. Clarify material year/date/reference ambiguity.

Use optional bounded model interpretation only over authorized candidates. Validate returned IDs and quotes against originals. This validates references, not semantic truth; evaluate semantic selection separately.

Persist selected message references and necessary source text, interpretations, evidence links, coverage, and retriever/prompt/configuration versions. Reuse completed snapshots after authorization checks. Failed preparation can be retried. Explicit re-evaluation records a new attempt rather than overwriting old context. Deletion and retention policies cover snapshots, indexes, and exported content.

## Turn lifecycle and evidence

Admission transaction: enforce identity and idempotency, persist the turn/run, establish ordering. Execute using an expiring run lease and ownership token; stale owners cannot finalize. Avoid holding database transactions across network calls. Deadline, search, token, and cost budgets apply to the whole run, including retries and provider fallback.

The admitted run can finish independently of the SSE subscriber. Disconnect closes the subscription; explicit cancellation stops work. Persist meaningful events and the final result, support reconnect by event cursor, and use heartbeats. Recovery is at-least-once execution with idempotent writes; exactly-once external model billing is not promised.

Recall is application infrastructure, not a second model-visible tool. The search tool normalizes evidence provenance, original observation time, snippet/page representation, completeness, and cache age. Cache keys include all result-affecting filters; a cache hit never rewrites observation time. Private query caches are scoped appropriately. If direct page fetch is added, validate destinations and redirects, block private-network access, and cap response sizes and types.

Separate what we said, what evidence was attached then, and what current evidence supports. Code checks reference integrity and normalized comparison dimensions; models and evaluations assess semantic support. Missing baseline means insufficient evidence, not proof of a prior error. “No change found” is not “unchanged.”

Stream progress during research; validate the structured answer before publishing research-answer content. Direct chit-chat streaming may bypass research. Durable post-turn extraction is queued transactionally with completion; extraction failures never hide original messages.

## Observability and traceability

One execution trace per attempt, linked by logical turn/run IDs. Child spans: admission, history preparation/retrieval/hydration/resolution, model calls, tool calls/provider attempts, validation, publication. Background jobs propagate or link trace context. Register telemetry once at process boot and prevent duplicate model instrumentation.

Correlate trace_id, run_id, attempt_id, turn_id, snapshot_id, prompt version, retriever version, model/provider ID, and search evidence IDs. Keep high-cardinality IDs in traces/logs, not metric labels. Cost estimates record token usage and the pricing-table version.

Dashboards: status latency, first answer content latency, total latency, queue wait, failures, retries, deadline exhaustion, cache hits, search freshness, token use, cost estimates, incomplete-history rate, clarification rate, and validation downgrades. LangSmith experiments compare candidate recall@k, reranker quality, final reference accuracy, citation support, and false change reports. Trace embedding generation, candidate ranks before/after fusion and reranking, selected source IDs, indexing lag, context tokens by category, omitted evidence, and compaction events. Log metadata rather than private candidate text by default.

Use application database provenance as the durable answer audit record. Sampled telemetry is not the audit database. Record observable decisions and tool results, not private model reasoning. Redact credentials and sensitive content before export; full prompts/content require explicit controlled retention policy. Telemetry failures must not fail user turns.

## Delivery and tests

Local: npm install && npm run dev starts the application with embedded persistence; real answers require configured model/search credentials. External telemetry, Redis, Docker, and cloud databases are not required for local startup. Serve built UI assets from Node in production. Document all credentials in .env.example and reject unsafe development auth in production.

Production: managed identity/OIDC with server-side authorization, secure session cookies, same-origin/CSRF policy, bounded request sizes, secret management, graceful shutdown, health/readiness checks, backups with restore verification, and separately executed backward-compatible migrations. Database ownership checks remain mandatory regardless of identity provider.

Initial single-replica rate limits can be in process. Before adding replicas, coordinate quotas and provider concurrency through the database or Redis; keep durable ordering/idempotency in PostgreSQL. Redis is not needed for the initial deployment.

CI: typecheck, lint, build, boundary tests, real-PostgreSQL adapter/concurrency tests, deterministic frozen-clock/recorded-provider evaluations, browser smoke tests. Mocked-provider load tests measure application capacity; separately measure real-provider latency/cost with a controlled budget. No measured results exist yet.

Boundary cases: competing shortlists; comparison interval distinct from discussion date; timezone/year ambiguity; lagging claims/embeddings; missing evidence; retrieval failure; tenant isolation; snapshot reuse and deletion; repeat admission; stale lease finalization; reconnection; changed billing dimensions; search injection; stale caches; provider partial failure; embedding model migration; filtered vector under-return; reranker failure; huge tool results; smaller-context model fallback; valid tool message pairing; and checkpoint replay after side effects. Large-history evaluations seed thousands of conversations with distractors and known source spans; no claimed scale without measurements.

Write the submission's one-page DESIGN.md after measurements exist. This architecture document is the longer implementation decision record. Existing repository is private; public submission remains a separate publishing step.

## Documentation checked

- https://nodejs.org/en/about/previous-releases
- https://hono.dev/docs/helpers/streaming
- https://pglite.dev/docs/about
- https://orm.drizzle.team/docs/get-started/pglite-new
- https://www.postgresql.org/docs/current/textsearch-tables.html
- https://docs.langchain.com/oss/javascript/langchain/models
- https://docs.langchain.com/oss/javascript/langgraph/overview
- https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance
- https://docs.langchain.com/oss/javascript/langchain/short-term-memory
- https://docs.langchain.com/oss/javascript/langchain/middleware/built-in
- https://docs.langchain.com/oss/javascript/integrations/embeddings/openai
- https://docs.langchain.com/oss/javascript/integrations/document_compressors/cohere_rerank
- https://github.com/pgvector/pgvector
- https://github.com/wanasit/chrono
- https://docs.tavily.com/documentation/api-reference/endpoint/search
- https://opentelemetry.io/docs/languages/js/
- https://docs.langchain.com/langsmith/observability
- https://vitest.dev/guide/
- https://playwright.dev/docs/intro
- https://grafana.com/docs/k6/latest/

# Time-Aware Research Agent — Product Requirements

Status: implementation and bounded evaluation complete against [the phased plan](plans/time-aware-research-agent.md). The local application and planned acceptance criteria are implemented and documented. Main chat routes through Token Harbor's `deepseek-v4.1-flash:free`; the verified Nova Micro fallback, Titan embeddings, and Cohere reranking remain on Bedrock. Three live assignment scenarios completed with cited findings and explicit historical evidence gaps; provider charges remain unreconciled. See the plan and evaluation reports for evidence and remaining limitations. This PRD is local only; it has not been published as an issue or deployed.

## Problem Statement

Research conversations accumulate decisions, shortlists, quotes, and assertions whose relevance changes over time. When someone asks whether Monday's CRM shortlist has changed pricing, a useful assistant must identify the actual shortlist, recover the original discussion, establish what evidence supported it, and check current sources. A plausible answer about five different CRMs is still wrong.

Ordinary conversation summaries and semantic similarity are insufficient for exact recall. A previous answer is not proof that a historical price was correct. Today's page does not necessarily establish when a price changed. Large histories, ambiguous dates, incomplete indexes, and limited model context make these distinctions harder to preserve.

The initial user needs a conversational assistant that can explain what was said, what was supported then, and what can be verified now, with visible uncertainty and usable source links. The developer and evaluator need a reproducible local application whose accuracy, latency, cost, and failure behavior can be inspected without provisioning cloud infrastructure.

## Solution

Build a local-first Node/TypeScript chat application with one model-visible tool: web search. It retrieves original conversation records through application infrastructure, resolves temporal references, and researches current evidence against the correct historical subjects.

Answers distinguish three layers: **what we said**, **what sources supported then**, and **what evidence supports now**. The assistant asks for clarification when competing historical references materially change the question. It reports incomplete evidence rather than inventing certainty, preserves every requested comparison subject, and provides explicit continuation when research reaches its budget.

Use the agreed architecture C: a stable historical-context boundary prepares a persisted per-run snapshot while a replaceable internal retriever handles lexical, semantic, temporal, and entity candidate discovery. Improving retrieval must not require rewriting turn orchestration or weakening exact-recall guarantees.

Use established packages for orchestration, model clients, tracing, and inference routing: LangGraph, LangChain, LangSmith, and LiteLLM. Main chat uses Token Harbor's OpenAI-compatible endpoint through LiteLLM; the verified fast fallback, embeddings, and reranking use AWS Bedrock. Provider keys stay at the gateway boundary. Chat and embeddings use OpenAI-compatible application interfaces; reranking has its own explicit gateway interface. Local operation is the delivery target; production deployment remains future work.

## User Stories

1. As a user, I want to start a conversation and ask a research question, so that I can get an evidence-based answer in one place.
2. As a user, I want immediate acknowledgement and meaningful progress updates, so that I can tell whether my request is running.
3. As a user, I want ordinary conversation to remain responsive, so that every message does not trigger unnecessary research.
4. As a user, I want research answers to include sources and an as-of time, so that I can assess their support and freshness.
5. As a user, I want to open a citation and inspect its supporting excerpt, so that I can understand why it was used.
6. As a user, I want snippets and page excerpts labeled accurately, so that I am not misled about how much of a source was read.
7. As a user, I want Monday's exact shortlist recovered, so that subsequent comparisons concern the products I actually considered.
8. As a user, I want questions from a specified date returned as original messages, so that I can inspect what I really asked.
9. As a user, I want large exact-recall results paginated chronologically with counts and continuation, so that a summary does not conceal omitted messages.
10. As a user, I want historical references resolved across my retained conversations, so that I do not need to remember which conversation contains a discussion.
11. As a user, I want cross-conversation recall to identify the original conversation and date, so that I can inspect the context.
12. As a user, I want unrelated questions to avoid importing other conversations, so that irrelevant private context does not shape the answer.
13. As a user, I want explicit dates and references to take precedence over conversational proximity, so that the assistant does not choose a convenient but incorrect discussion.
14. As a user, I want clarification when multiple earlier discussions plausibly match, so that the assistant researches the intended one.
15. As a user, I want an honest distinction between no matching history and incomplete retrieval, so that an outage is not presented as absence.
16. As a user, I want my browser timezone initialized and editable, so that dates match my intended local day.
17. As a user, I want timezone fallback and omitted-year assumptions shown when relevant, so that I can correct a mistaken interpretation.
18. As a user, I want historical relative dates interpreted from the original message, so that an old reference to tomorrow does not move with today's date.
19. As a user, I want the comparison period distinguished from the date of the original discussion, so that asking about changes since Monday does not incorrectly constrain recall to Monday.
20. As a user, I want previous statements separated from historical source support, so that an earlier unsupported answer does not become a verified baseline.
21. As a user, I want an earlier assistant mistake corrected explicitly, so that it is not described as a real-world change.
22. As a user, I want later corrections preserved alongside original messages, so that future references improve without rewriting the record.
23. As a user, I want historical evidence discovered today labeled as reconstructed, so that I know it was not verified during the original discussion.
24. As a user, I want my own quoted price usable as an attributed baseline, so that I can compare a personal offer without presenting it as a public price.
25. As a user, I want prices compared using matching plans, currencies, billing periods, seats, regions, and tax assumptions, so that incompatible offers do not produce false changes.
26. As a user, I want missing baseline evidence disclosed, so that a current price does not imply a proven historical change.
27. As a user, I want unresolved source disagreements explained, so that the answer does not invent a definitive conclusion.
28. As a user, I want no relevant change found distinguished from proof of no change, so that uncertainty remains visible.
29. As a user, I want significant updates judged against my stated needs, so that vendor marketing does not substitute for relevance.
30. As a user, I want explicit current verification to use fresh or transparently reusable evidence, so that cached content does not appear newly observed.
31. As a user, I want all requested products accounted for, so that a context limit cannot silently drop one from a comparison.
32. As a user, I want useful verified partial findings and named gaps when research stops, so that I can act on supported results.
33. As a user, I want to explicitly continue unfinished research, so that additional work has a clear new budget and time anchor.
34. As a user, I want to cancel an active request, so that I control further work and expenditure.
35. As a user, I want a wait or stop-and-send choice when another turn is active, so that a new reference is not silently queued against an unseen answer.
36. As a user, I want reconnection to recover the same run and answer, so that a network interruption does not lose completed work.
37. As a user, I want retries to avoid duplicate messages and answers, so that accidental resubmission is harmless.
38. As a user, I want conversations to remain available after restarting the local application, so that my research is durable.
39. As a user, I want recoverable interrupted runs to resume safely, so that a process crash does not corrupt the discussion.
40. As a user, I want to exclude a conversation from automatic recall elsewhere, so that retained content can remain accessible without influencing other discussions.
41. As a user, I want deletion to remove originals and their derived retrieval material, so that deleted content cannot reappear through caches or snapshots.
42. As a user, I want ownership checked for history, citations, events, and vectors, so that another user's records cannot enter my answers.
43. As a user, I want web-page instructions treated as untrusted content, so that retrieved text cannot change the assistant's authority or expose private history.
44. As a user, I want dependency failures described clearly, so that stale or incomplete answers are not presented as fully verified.
45. As a developer, I want a documented local startup using the required npm commands, so that reviewers can run the application reproducibly.
46. As a developer, I want actionable configuration and readiness failures, so that unavailable credentials or services are not hidden by synthetic results.
47. As a developer, I want logical inference roles behind LiteLLM, so that I can change compatible providers without rewriting research logic.
48. As a developer, I want model capabilities checked before use, so that streaming, tools, structured output, or context assumptions do not fail silently.
49. As a developer, I want embeddings tied to immutable space identities, so that changing models cannot corrupt retrieval through mixed vectors.
50. As a developer, I want retrieval strategies replaceable behind a stable contract, so that embedding, fusion, and reranking improvements can be evaluated independently.
51. As a developer, I want original-record retrieval to work while indexing is delayed or unavailable, so that indexing is not a prerequisite for correct recall.
52. As a developer, I want bounded inference, search, and indexing work, so that failures and large histories cannot create unbounded expenditure.
53. As a developer, I want context checked before every model invocation, so that oversized inputs and smaller fallback models are handled deliberately.
54. As a developer, I want traces connecting admission, retrieval, search, inference, and publication, so that I can explain an answer and diagnose latency.
55. As a developer, I want real-user content redacted by default in external telemetry, so that observability does not require exporting private conversations.
56. As a developer, I want frozen-clock fixtures and recorded search evidence, so that correctness regressions are reproducible.
57. As an evaluator, I want measured retrieval, answer-quality, latency, and cost results with their conditions, so that I can distinguish evidence from design aspirations.
58. As an evaluator, I want a concise design explanation grounded in the implemented system, so that I can assess its tradeoffs and remaining limitations.

## Implementation Decisions

### Scope and package ownership

- Implement a strict TypeScript Node application with Hono, a React/Vite chat interface, Zod validation, and SSE transport. Node is an assignment constraint.
- Use LangGraph JS for bounded graph execution and packaged checkpoint persistence. Use LangChain's OpenAI-compatible clients and relevant utilities rather than maintaining provider SDK adapters in application code.
- Use a separate local LiteLLM process for provider routing. AWS credentials belong at the gateway boundary, never in browser code or model prompts. The application receives gateway endpoint, credential, logical model bindings, and capability configuration.
- Use LangSmith for traces and evaluation experiments; use OpenTelemetry and structured Pino logs for operational visibility. Neither is the authoritative answer store.
- Use file-backed PGlite for local application data and vector retrieval, subject to integration verification, and the packaged SQLite LangGraph saver for local execution state. These stores do not share a transaction; recovery must reconcile them explicitly.
- Run API and bounded local workers in one Node application process initially. Persist background jobs locally. Redis, managed services, and multiple application replicas are not prerequisites.

### Module contracts

| Module | Inputs and outputs | Responsibility hidden behind the boundary |
| --- | --- | --- |
| Transport and identity | Validated client requests and local development identity → authorized commands, paginated records, event streams | Ownership checks, input limits, safe errors, SSE replay, presentation |
| Turn lifecycle | Authorized input and idempotency key → durable turn/run identity and terminal state | Atomic admission, ordering, quotas, durable dispatch, cancellation, recovery, publication ownership |
| Historical context | Authorized turn with fixed time and cutoff → persisted history snapshot or typed clarification/coverage result | Date interpretation, reference resolution, original hydration, provenance, correction and recall policies |
| History retriever | Owner-scoped retrieval intent and eligible visibility scope → ranked candidates with source identifiers and coverage | Lexical/vector/entity/temporal discovery, fusion, optional reranking, bounded expansion |
| Indexing | Committed source records and index generation → derived chunks, vectors, claims, and progress | Idempotent jobs, batching, validation, lag tracking, reindexing and deletion races |
| Context compiler | Required subjects, messages, observations, and model capabilities → budgeted model input or explicit inability to fit | Token accounting, evidence selection, compaction, protocol validity, subject coverage |
| Research workflow | Authorized run, history snapshot, shared budget → structured draft, clarification, or partial result | Routing, bounded LangGraph execution, one search tool, iteration and task decomposition |
| Search service | Queries and runtime-injected limits → evidence observations and per-query failures | Provider calls, caching, deduplication, freshness, optional safe content fetching |
| Answer publisher | Structured draft and authorized evidence registry → durable answer and replayable final event | Structural validation, comparison prerequisites, safe rendering, single final publication |
| Inference boundary | Logical role and capability-checked request → typed result and usage | Thin gateway clients, timeouts, shared retry accounting, embedding-space checks, separate rerank protocol |
| Diagnostics and evaluation | Correlated events and fixtures → traces, metrics, reproducible reports | Redaction, sampling, regression comparisons, operational failure isolation |

The historical-context boundary remains stable when the retriever changes. Graph code consumes original-backed context and explicit coverage, not vector scores or a retriever-specific schema. Historical snapshot persistence and graph checkpointing have different purposes and must remain distinct.

### Time, ownership, and recall

- Capture a fixed current time, IANA timezone, and committed owner-wide historical cutoff when admitting each turn. Supply the current input separately from the historical baseline.
- Use half-open local-date windows converted to instants. Initialize timezone from the browser, allow editing, and show UTC fallback. Infer an omitted year as the most recent past date consistent with context; disclose the assumption and clarify materially ambiguous cases.
- Anchor quoted historical relative dates to the original message. Interpret the period being compared separately from the date used to find the discussion.
- Exact date recall queries original records directly with stable chronological pagination, count, and cursor. It must not depend on semantic top-k completeness.
- Historical references may search eligible retained conversations owned by the user. Prefer an unambiguous current-conversation match only when it does not contradict explicit references. Attribute cross-conversation context to its source conversation.
- Historical preparation returns resolved, clarification-needed, no-match, incomplete, or not-needed outcomes. Coverage records searched windows, truncation, index lag, degraded branches, and pagination. Retrieval failure must not become no-match.
- Preserve original messages. Append corrections and use them for subsequent reference resolution without rewriting exact recall or original evidence links.
- Every private access is owner-scoped. A local development identity is acceptable initially; the backend must not accept arbitrary client-supplied owner IDs as authority. Exercise multiple fixture identities in isolation tests even though hosted authentication is deferred.
- Recall exclusion prevents subsequent automatic use in other conversations through all derived representations. Deletion and eligibility changes invalidate snapshot/cache reuse; recheck authorization and eligibility before use and publication.

### Retrieval, embeddings, and context size

- Create derived chunks with original-message identifiers, source spans, and content hashes. Retrieve children for discovery and hydrate original parent exchanges for interpretation. Preserve complete shortlists rather than relying on arbitrary chunk boundaries.
- Combine temporal/entity, lexical, vector, and relevant recent-context branches. Enforce owner, cutoff, and recall filters during candidate discovery, not just after ranking.
- Fuse rankings with reciprocal-rank fusion rather than adding incomparable provider scores. Conditionally rerank candidates through the gateway, then hydrate originals. Permit one bounded expansion when initial coverage is inadequate.
- Treat candidate counts and chunk sizes as tunable hypotheses: initially consider 400–800-token chunks with 50–100-token overlap, up to roughly 40 rerank candidates, and 6–12 hydrated parents. These limits never justify silently incomplete exact recall or subject coverage.
- Validate every vector for dimension, finite values, and nonzero norm. An embedding-space identity includes model binding, dimensions, normalization, query/document input modes, and chunking/index generation. Equal dimensions do not imply compatibility.
- Keep embedding generations separate. Reembedding requires a new generation, evaluation, and explicit cutover with rollback; never automatically fall back to a different embedding model within the active space.
- Track indexing progress without advancing past unfinished holes. Original records become available immediately. Embedding failure falls back to lexical/original retrieval with disclosed coverage; rerank failure falls back to fused ordering.
- Start with exact vector search where appropriate for local data sizes. Introduce approximate indexing based on measurement and test filtered under-return before relying on it.
- Compile context before every model call, including summaries and repairs. Account for instructions, current input, tool schemas, tool messages, evidence, output/reasoning allowance, and safety margin using model-aware or conservatively validated counting.
- Deduplicate and trim low-value content first. Summaries may compress continuity but cannot replace originals for exact recall or evidence for verification. Preserve tool-call/result pairing and all required subjects.
- Validate context against the actual model and any permitted fallback's capacity. On overflow, allow one bounded recompilation, then bounded subject-level tasks, clarification, or an explicit partial answer. All tasks share the parent deadline and expenditure budget.

### Evidence and answer correctness

- Expose only web search as a model-visible tool. History, embeddings, reranking, and persistence are infrastructure operations. The model cannot supply its own owner identity, deadline, or expanded quotas.
- Start with the planned Tavily integration behind the search boundary. Provider fallback is optional and must be tested before enabled. Search fan-out occurs after historical subjects are resolved.
- Preserve evidence observations with query identity, URL, representation type, excerpt/content hash, provider, observation time, and separately known publication/effective dates. Unknown effective dates remain unknown. A URL alone is not a historical snapshot.
- Fresh verification requires new search/source validation unless a declared brief cache policy permits reuse. Cache access never resets observation time. Cache keys include relevant query filters and freshness policy.
- Prefer official pricing and release sources while retaining conflicting or relevant alternative evidence. Require price passages supporting the comparison dimensions. Fetch through the search service when needed; otherwise qualify or abstain.
- If direct fetching is enabled, restrict schemes, block private/internal destinations, revalidate redirects and resolved addresses, bound size/time/content types, and forward no credentials. Retrieved instructions remain untrusted data. Render citations and Markdown safely.
- Structured drafts identify required subjects, baseline provenance, current observations, comparison dimensions, conclusions, and gaps. Reconstructed baselines require explicit evidence for the earlier period; current-only observations cannot establish them.
- Deterministic validation checks citation ownership and existence in the authorized run evidence registry, required subjects, as-of information, baseline/current prerequisites, and compatible comparison dimensions. It does not prove semantic entailment; source support also requires evaluation.
- No-baseline, conflicting-source, prior-error, user-reported, reconstructed, and no-change-found outcomes require distinct wording. Significant changes must explain relevance to user needs.
- Research emits progress first and answer content after validation. Final publication atomically records the answer and durable final event. Unsupported drafts must be repaired within the remaining budget or reduced to supported partial findings.

### Data and lifecycle contracts

| Record group | Required purpose and relationships |
| --- | --- |
| Conversations and original messages | Owner, timezone/preferences, recall eligibility, immutable original content, recorded time, committed owner ordering, correction links |
| Turns and runs | Idempotency payload hash, status, fixed time/cutoff, budgets, model/config versions, cancellation, timing, continuation link, final-answer identity |
| History snapshots | Run-bound resolved references, original source spans, provenance, coverage, eligibility version; never a substitute for ownership checks |
| Index generations, chunks, and embeddings | Immutable space identity, source relationships, hashes, validated vectors, generation status and indexing progress |
| Search queries and evidence observations | Run associations, source representations, original observation time, freshness and provenance |
| Answer claims and evidence links | Structured claims linked to original statements, historical/current evidence, comparison dimensions and uncertainty |
| Jobs and run events | Durable dispatch, attempts, lease/ownership where applicable, cancellation/deletion work, ordered replay and terminal publication |
| Framework checkpoints | Per-run graph execution state managed through the packaged saver and reconciled with application state |

- Enforce foreign keys and uniqueness for logical idempotency and final publication. Source-write ordering must reflect committed visibility; do not assume allocated sequence order equals commit order. No database transaction spans network inference.
- Admission atomically records the user input, run, and execution job. A repeated key with the same payload returns the same logical turn; a changed payload conflicts.
- Permit one active run per conversation initially. Concurrent input receives an explicit conflict and wait/stop-and-send interaction rather than an implicit queue. Bound per-user and global inference/search concurrency separately from indexing.
- HTTP operations cover conversation creation/listing, paginated originals, turn admission, run status/events/cancellation/continuation, citations, recall preference, and deletion. Validate all inputs and return safe typed errors with correlation IDs.
- SSE uses run-scoped ordered event identities. Persist important progress and terminal events; reconnect supplies a cursor and recovers canonical state. Completion before subscription must still be visible. Replaying every generated token is not required.
- Browser disconnect does not cancel durable work. Explicit cancellation stops further work where supported and prevents late final publication by stale execution. Recovery reconciles checkpoints, jobs, and terminal application state idempotently.
- Provider calls are at-least-once across crash windows; do not promise exactly-once billing. Application retries must still avoid duplicate logical messages and finals.
- Retain originals and bounded evidence excerpts until deletion initially. Use shorter configurable operational-log retention. Deletion immediately prevents reads/reuse, then durably purges dependent chunks, claims, snapshots, evidence associations, checkpoints, and caches without allowing in-flight jobs to resurrect content.

### Inference, budgets, and observability

- Current local model bindings are Token Harbor `deepseek-v4.1-flash:free` for main chat, Nova Micro through Bedrock as the separately verified fast fallback, Titan Text Embeddings V2 with 1024 normalized dimensions, and Cohere Rerank 3.5 through Bedrock. They are development routes, not established quality winners.
- Chat and embeddings use OpenAI-compatible gateway interfaces. Reranking uses a separately configured Cohere-style gateway contract; portability does not mean every provider implements that endpoint.
- Pin and record gateway, client, model-binding, prompt, graph, retrieval, and schema versions. Verify full tool continuation, streaming, structured-response validation, embeddings, and reranking with actual chosen clients before declaring integration complete.
- Start with a configurable 60-second research deadline and bounded calls, rounds, queries, input/output tokens, and retries. Account for gateway retries in the total attempt budget. Enforce backpressure and share limits across graph tasks.
- On expiry, publish supported partial findings with explicit gaps when possible. Continuation is a linked new run with fresh time and budget, not a hidden deadline reset. Background indexing has separate concurrency and expenditure limits.
- Measure small controlled live runs before selecting dollar regression gates. No total live-evaluation dollar budget has been supplied; this PRD does not authorize an unbounded experiment.
- Correlate request, turn, run, graph, search, inference, and job events. Record route, retrieval coverage, selected references, context size/compactions, cache hits, provider timing, retries, usage, estimated cost, and validation outcomes.
- Distinguish acknowledgement latency, first visible progress, first answer content, and completion latency. Report estimates as estimates and unknown pricing as unknown, not zero.
- Redact real-user content from external traces and gateway logs by default. Full synthetic traces are allowed. Trace export failure cannot fail a user turn; persistent answer provenance remains available independently.

## Testing Decisions

Tests should assert externally observable contracts and invariants through the major module boundaries. Use real local persistence and mocked external service responses for deterministic tests. Avoid tests that merely reproduce private helper implementations or depend on exact generated prose.

Existing prior art consists of bounded local gateway verification helpers and a sanitized inference report. There is no implemented chat application or application test suite to inherit. Those checks establish limited transport/model access, not end-to-end research correctness.

| Boundary | Required evidence |
| --- | --- |
| Temporal/history preparation | Timezone edits, UTC fallback, midnight/DST, missing-year interpretation, old relative dates, comparison period versus discussion date, stable cutoff, original pagination |
| Reference resolution | Correct shortlist among distractors, explicit references overriding proximity, cross-conversation attribution, ambiguity, corrections, no unrelated recall, missing versus incomplete history |
| Retrieval/indexing | Delayed and partial indexing, duplicate jobs, invalid/zero vectors, lexical fallback, rerank timeout, filtered under-return, generation mismatch/cutover/rollback, complete subjects |
| Context compiler | Huge inputs/results/history, smaller fallback window, compaction budget, valid tool pairing, preserved required evidence and subjects, explicit inability to fit |
| Search and publisher | Freshness preservation, snippet versus page, source passage requirements, baseline reconstruction, user quotes, conflicts, prior mistakes, false-change cases, invalid citations, safe rendering |
| Turn lifecycle and persistence | Duplicate and conflicting keys, concurrent local admission, completion before subscription, replay, process restart, crash windows, cancellation, late writes, single final publication |
| Privacy and isolation | Wrong-owner IDs across every route/retrieval path, excluded history through derived data, deletion during indexing/research, cache reuse, unsafe fetch destinations, hostile source instructions |
| Inference and diagnostics | Actual client tool-result continuation, malformed structured output, capability mismatch, timeouts and bounded retries, token/cost accounting, redaction, unavailable telemetry |
| Browser experience | Research, exact recall, clarification, source inspection, timezone correction, stop-and-send, reconnect, partial continuation, recall exclusion, deletion |

Use frozen clocks, original-message fixtures, recorded search observations, known supporting spans, and versioned configurations. Include thousands of distracting exchanges, repeated product names, conflicting prices, incomplete indexes, and a five-product comparison where one subject is difficult to retrieve.

Separate deterministic tests from live model evaluations. Compare candidate recall, reference accuracy, complete-subject coverage, supported citations, false-change rate, correct clarification/abstention, latency, and cost. Human-reviewed fixtures establish historical identity and numerical comparison truth; model judges are supplemental.

Run the agreed local mocked workload of 100 connected clients and 10 active research turns with background indexing. Record hardware, history size, payload sizes, cache conditions, model/provider or mocks, p50/p95 latency, errors, and backlog. Exercise slow consumers, reconnect bursts, process crashes, and dependency failures. This workload is a test target, not a capacity claim. Measure live-provider latency and cost separately.

Initial local acceptance gates:

- A clean checkout runs using the required npm workflow after clearly documented gateway/service prerequisites; configuration failures are actionable and fixtures are never silently substituted for live research.
- The three assignment examples retrieve the correct originals and produce evidence-qualified comparisons under deterministic fixtures and a recorded quality evaluation.
- No cross-user leakage, fabricated citations, duplicate final publication, incompatible accepted vectors, silently omitted subjects, or broken single-process local recovery remains in the acceptance suite.
- Original-record fallback works while indexing is unavailable; exclusion and deletion cannot be bypassed through derived material.
- Every model call is budgeted, deadline/continuation behavior works, and credentials/private content remain outside committed artifacts and default external traces.
- Numeric quality, latency, and cost regression gates are selected after baseline measurement and recorded before model/retrieval optimization is accepted. No benchmark is marked passed without a reproducible result.

Real PostgreSQL concurrency, multi-process checkpoint fencing, production identity, hosted backups/restore, and service-level recovery require separate future deployment tests. Passing PGlite tests does not establish those properties.

## Out of Scope

- Cloud deployment, infrastructure provisioning, managed databases, production identity-provider rollout, multi-replica operation, multi-region writes, and production service-level commitments.
- Publishing the repository, opening a GitHub issue, or submitting the hiring assignment during this local PRD task.
- Additional model-visible tools, unrestricted browsing, code execution, autonomous multi-agent teams, scheduled watches, and notifications.
- Building a custom inference gateway, provider SDK framework, graph framework, or vector database.
- Selecting a final best model based only on successful connectivity checks, changing AWS billing/subscriptions to unlock models, or running an unbounded paid benchmark.
- Treating summaries or embeddings as authoritative recall, silently substituting embedding models, or guaranteeing that a deterministic validator proves semantic truth.
- Arbitrary document ingestion beyond conversation history and search evidence in the initial product.

## Further Notes

The approved [architecture](ARCHITECTURE.md) remains the detailed engineering reference; the [domain glossary](CONTEXT.md) defines shared terminology. The [assignment](problem_statement.md) supplies the Node, startup, one-tool, and eventual submission constraints. This PRD translates those decisions into product behavior and verification requirements rather than reopening the completed interview.

As of 2026-11-17, the repository contains architecture documentation, local LiteLLM configuration, startup helpers, and bounded inference checks. The [verification report](docs/INFERENCE_VERIFICATION.md) records successful Token Harbor main-chat, tool-call, and structured-output checks; Nova Micro fallback and Titan embedding checks; and the earlier Cohere rerank result. Three live assignment scenarios completed; evidence and limitations are tracked in [Phase 12 live evaluation](docs/PHASE12_LIVE_EVALUATION.md). Earlier Claude routes failed an account payment prerequisite; no subscription or payment settings were changed. Individual observed durations are diagnostic samples, not benchmarks.

Deliver through vertical slices: a durable conversational research turn with citations; exact temporal recall and source provenance; cross-conversation hybrid retrieval and bounded context; resilient cancellation/recovery and privacy controls; then comparative evaluations and measured documentation. Each slice should exercise its public behavior end to end rather than completing every infrastructure layer before a usable turn exists.

The eventual one-page design document must describe the implemented system, rejected alternatives, measured results, and next-week priorities. Public repository publication and submission remain separate future actions. Remaining empirical decisions include final retrieval/model choices, broader quality evidence, tokenizer accuracy, hosted performance, and reconciliation of provider billing. The live run has narrow usage-proxy gates but no monetary-cost pass; these limitations do not change the completed local implementation status.

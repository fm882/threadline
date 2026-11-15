# Plan: Time-Aware Research Agent

> Source PRD: [Time-Aware Research Agent — Product Requirements](../PRD.md)
>
> The user approved this 12-phase breakdown. Checked criteria have targeted evidence; unchecked criteria and incomplete phases remain work in progress. This is a local implementation plan, not a deployment or publishing plan.

## Architectural decisions

- **Application boundary:** strict TypeScript on Node, Hono HTTP API, React/Vite interface, validated inputs, and SSE. API and bounded workers initially share one Node application process. LiteLLM is a separate local service. The documented npm installation and development startup workflow must work after explicit service prerequisites.
- **Ownership:** a server-controlled local development identity authorizes every conversation, message, run, citation, event, snapshot, and retrieval operation. Browser-supplied owner identifiers are not authority. Multiple test identities exercise isolation from the first phase. Hosted identity provisioning is deferred.
- **Orchestration:** LangGraph manages bounded execution with packaged checkpoint persistence. A run has its own execution identity; conversation continuity comes from authorized historical context. History snapshots explain the context used; checkpoints resume execution. They are not interchangeable.
- **Inference:** application chat and embedding clients use OpenAI-compatible interfaces through LangChain and LiteLLM. Initial inference is AWS Bedrock: Nova Pro for main chat, Nova Micro for fast work, Titan Text Embeddings V2 with 1024 normalized dimensions, and Cohere Rerank 3.5. These are accessible development baselines, not quality winners. Reranking uses a separate gateway contract. Provider credentials remain at the gateway boundary.
- **Model capabilities:** logical role bindings and capability records govern tool use, structured responses, streaming, context capacity, and usage accounting. A provider change requires compatibility checks. Embedding-model changes require separate vector generations even when dimensions match.
- **Single tool:** web search is the only model-visible tool. Historical retrieval, embeddings, reranking, persistence, and context compilation remain application operations. Start with Tavily behind the search boundary; enable alternative providers only after verifying their behavior.
- **Local persistence:** file-backed PGlite holds application records and vectors, subject to integration verification. The packaged SQLite saver holds graph checkpoints. These stores do not share an atomic transaction; local recovery reconciles them. PostgreSQL deployment and multi-replica proofs are future work.
- **Stable history contract:** historical preparation consumes an authorized turn with fixed time, timezone, and committed visibility cutoff. It produces persisted original-backed context with resolved, clarification-needed, no-match, incomplete, or not-needed status and explicit coverage. Internal retrieval may improve without changing this boundary.
- **Time and truth:** original records establish what was said. Source observations establish what was observed, with publication/effective dates only where supported. Current evidence does not establish historical truth automatically. Corrections append; exact recall preserves originals. User-reported and reconstructed baselines remain explicitly attributed.
- **Budgets:** every model invocation is context-checked from its first introduction. Every research run has finite calls, queries, rounds, retries, and tokens, with a configurable starting deadline of 60 seconds. Background work has separate limits. Later phases improve large-context handling and useful deadline outcomes; they do not introduce basic limits for the first time.
- **Visibility and lifecycle:** admit input, run, and dispatch job atomically. Preserve a committed owner-wide history cutoff without holding transactions across external calls. Allow one active run per conversation. A browser disconnect does not cancel work. Explicit cancellation and durable terminal state prevent late publication.
- **Observation and privacy:** correlate request, run, retrieval, search, inference, and publication through LangSmith and operational telemetry. Real-user content is redacted by default; synthetic evaluation traces may contain full content. Telemetry failure must not fail turns. Durable provenance is independent of sampled traces.

### Route contracts

| Route | Durable behavior |
| --- | --- |
| `POST /api/conversations` | Create an owned conversation |
| `GET /api/conversations` | List owned conversations with pagination |
| `GET /api/conversations/:id/messages` | Retrieve original messages with stable chronological pagination and applicable date filtering |
| `POST /api/conversations/:id/turns` | Admit a turn using an idempotency key; return durable identifiers; optionally reference a prior incomplete run for an explicit continuation |
| `GET /api/runs/:id` | Return canonical active or terminal run state |
| `GET /api/runs/:id/events` | Subscribe/reconnect to owner-scoped SSE with ordered event cursors |
| `POST /api/runs/:id/cancel` | Request idempotent explicit cancellation |
| `GET /api/evidence/:id` | Inspect authorized evidence and provenance |
| `PATCH /api/conversations/:id` | Update allowed conversation preferences, including timezone and recall eligibility |
| `DELETE /api/conversations/:id` | Immediately revoke access and durably clean up dependent records |
| `GET /health/live` | Report process liveness independently of provider health |
| `GET /health/ready` | Report safe admission readiness with actionable configuration failures |

The conversation preference update and continuation admission semantics complete the PRD's behavioral contracts; they do not add model-visible tools. Initial admission returns accepted run identifiers. An identical idempotent retry returns the original logical turn; key reuse with a different payload conflicts. Concurrent input conflicts rather than silently queueing. Stream replay guarantees canonical status/final results, not byte-for-byte regeneration of every token.

### Schema shape and key models

| Model group | Durable relationships and invariants |
| --- | --- |
| Conversation, OriginalMessage, Correction | Owner, timezone, recall eligibility, immutable originals, recorded time and committed owner ordering; corrections reference preserved originals |
| Turn, Run | Conversation, idempotency payload identity, status, fixed time/cutoff, budgets, configuration versions, cancellation and optional continuation ancestry |
| HistorySnapshot | Run-bound references to original spans/hashes, source conversations, coverage and eligibility version; reuse requires current authorization |
| SearchQuery, EvidenceObservation | Run associations, URL, representation, excerpt/hash, provider, observation time and separately supported publication/effective dates |
| Answer, AnswerClaim, ClaimEvidence | One canonical final publication per run; explicit subject coverage, baseline types, comparison dimensions, evidence links and uncertainty |
| IndexGeneration, HistoryChunk, Embedding | Source relationships, immutable embedding-space identity, validated vectors, generation state and progress without unfinished holes |
| Job, RunEvent | Durable dispatch and cleanup, attempts/ownership, ordered meaningful events, terminal publication and replay |
| GraphCheckpoint | Packaged execution state associated with a run and reconciled with application terminal state |

Introduce each record group with the first behavior needing it. Do not build all schemas as a separate horizontal phase. Every new derived representation must inherit ownership, exclusion, deletion, provenance, and versioning requirements.

### Delivery and verification rules

Implement the numbered phases in order; dependency notes identify necessary predecessors rather than authorizing parallel work. Every phase includes its visible interaction, durable state, API behavior, trace evidence, and boundary tests. Earlier criteria remain regression requirements. Story numbers may repeat because later phases extend earlier behavior; mapping a story is not evidence that it is complete.

Use real local persistence, frozen clocks, and recorded external responses for deterministic acceptance. Keep live model quality and provider compatibility checks separate, bounded, and labeled. A completed phase has a reproducible demo and passing acceptance evidence, not merely completed components. The final evaluation phase consolidates checks already developed throughout the earlier slices.

---

## Phase 1: Local chat that survives restart

**User stories**: 2, 3, 37, 38, 42, 45, 46, 47, 48, 52, 53, 54, 55.

**Dependencies**: Existing gateway configuration and inference helpers; no completed application phase assumed.

### What to build

A user starts the local application, creates a conversation, sends ordinary chat through the actual gateway client, sees acknowledgement and streamed content, and reopens the persisted conversation after restart. The first turn establishes authorized admission, durable run identity, bounded execution, canonical publication, and redacted tracing. It uses packaged graph persistence from the outset while advanced interrupted-run recovery is completed in phase 3.

### Acceptance criteria

- [x] A clean local setup reaches a working browser chat through the required npm workflow after documented gateway prerequisites; missing configuration produces actionable readiness/UI errors rather than fabricated replies.
- [x] The actual application client completes a chat turn through the logical gateway model binding. Streaming and terminal state are observable; incompatible capabilities fail clearly.
- [x] Original input and final response survive a clean process restart and appear in an owned, paginated conversation history.
- [x] Identical admission retries return the same turn; changed payloads under the same key conflict. Only one final answer is published.
- [x] A second active turn in the same conversation receives an explicit conflict. Current input is separate from a fixed historical visibility cutoff.
- [x] Wrong-owner conversation, message, run, and event access is rejected in multi-identity fixtures; identity cannot be selected by an untrusted request field.
- [x] All calls have context/output, time, and attempt limits. Oversized input and dependency failure produce safe errors without leaking provider credentials.
- [x] A correlated synthetic trace joins admission, inference, and publication; real-user content is redacted by default and exporter failure does not fail the turn.

---

## Phase 2: Research with inspectable citations

**User stories**: 1, 4, 5, 6, 30, 43, 44, 56.

**Dependencies**: Phase 1.

### What to build

A user asks a current research question and sees progress followed by a validated answer with an as-of time and inspectable supporting excerpts. Execute a complete model tool-call/result continuation using only web search. Persist observations and answer claims so citation inspection works after restart. Route ordinary chat without unnecessary search.

### Acceptance criteria

- [x] A current question completes through UI, authorized run, search, model continuation, structured validation, persisted answer, and citation inspection.
- [x] Exactly one model-visible tool is available. Runtime supplies identity and budgets; retrieved text cannot expand authority.
- [x] Citations reference actual authorized observations registered with the run; invented or wrong-owner identifiers prevent publication.
- [x] Citation inspection displays snippet/page-excerpt representation and original observation time. Cache hits never create a new observation timestamp.
- [x] Freshness policy distinguishes explicit current verification from ordinary reuse; stale or unavailable research is disclosed.
- [x] Research content is published after validation while progress arrives earlier. Source text and hostile Markdown are handled safely.
- [x] Price passages missing necessary details produce qualification or abstention. If direct fetching is enabled, unsafe destinations, redirects, response sizes, and content types are tested before use.
- [x] Frozen-clock search fixtures reproduce the answer contract, including malformed tool responses, prompt injection, and unavailable search. A bounded real-client check verifies tool-result continuation separately.

---

## Phase 3: Stop, reconnect, and recover a research run

**User stories**: 34, 35, 36, 37, 38, 39.

**Dependencies**: Phases 1–2.

### What to build

A user reconnects to an ongoing or completed research run, chooses to wait or stop-and-send, and recovers from an application interruption. Exercise the existing durable jobs, graph checkpoints, and terminal publication together through the same chat interaction.

### Acceptance criteria

- [x] Disconnecting leaves work running; reconnecting recovers canonical progress or final state, including completion before the first subscription.
- [x] Event cursors handle replay and unavailable old cursors without duplicate logical answers. Slow subscribers cannot create unbounded buffers.
- [ ] Cancellation is idempotent, prevents further scheduled work, and blocks late final publication. The UI accurately distinguishes cancellation from completion that already won the race.
- [x] Stop-and-send admits the replacement only after the prior run is terminal; waiting does not silently enqueue a new input.
- [x] Killing and restarting the local process at admission, tool-result, checkpoint, and publication boundaries produces one logical turn and no duplicate final.
- [x] Recovery reconciles application state with the separate checkpoint store; stale execution cannot overwrite terminal state.
- [x] The test report distinguishes application idempotency from possible repeated provider billing across a crash window.

---

## Phase 4: Exact recall by local date

**User stories**: 8, 9, 15, 16, 17, 18.

**Dependencies**: Phases 1–3.

### What to build

A user asks what they said on a date and receives original questions, source conversation links, the interpreted local date, and chronological pagination. The browser supplies an editable timezone. Persist the historical preparation result and coverage for the run; exact recall works without embeddings or model-generated reconstruction.

### Acceptance criteria

- [ ] Browser timezone initialization, editing, and visible UTC fallback affect subsequent date interpretation correctly.
- [ ] Midnight boundaries and daylight-saving transitions return the right originals using half-open local-day windows.
- [ ] Omitted years use the stated context-consistent past interpretation; materially ambiguous interpretations request clarification.
- [ ] Historical relative dates are anchored to original message time, not the current run's time.
- [ ] Hundreds of matching questions return stable chronological pages, counts, and continuation without vector top-k omissions; a summary cannot replace originals.
- [ ] No match, failed retrieval, and incomplete coverage have distinct visible outcomes.
- [ ] Later messages cannot enter the run's fixed baseline; wrong-owner originals and snapshots remain inaccessible.

---

## Phase 5: Resolve earlier discussions across conversations

**User stories**: 7, 10, 11, 12, 13, 14, 15, 19, 50, 51.

**Dependencies**: Phase 4 and the phase 2 research path.

### What to build

A user refers to an earlier shortlist without knowing its conversation location. Lexical, temporal, entity, and continuity retrieval discover candidate discussions through the stable historical-context boundary, hydrate originals, and either resolve the reference or ask a useful clarification. An approved reference can feed a current research answer while unsupported historical comparisons remain qualified.

### Acceptance criteria

- [ ] The original five-product shortlist is recovered intact among repeated names and competing discussions; source conversation title/date/link is visible.
- [ ] Explicit dates and references override a convenient current-conversation candidate when they conflict.
- [ ] Multiple plausible discussions that materially change the answer produce a clarification interaction; the user's choice resolves a subsequent authorized turn.
- [ ] An unrelated question does not import cross-conversation history.
- [ ] The discussion date and requested comparison interval are interpreted independently.
- [ ] The graph consumes original-backed context and explicit coverage without depending on retriever scores or implementation details.
- [ ] Original retrieval remains usable with no semantic index; failed discovery is not reported as absence, and bounded expansion cannot become an unbounded search loop.

---

## Phase 6: Compare historical and current evidence

**User stories**: 20, 21, 22, 25, 26, 27, 28, 29, 30.

**Dependencies**: Phases 2 and 5.

### What to build

A user asks whether the earlier answer is still correct. Recover its original statements and attached historical evidence, obtain current observations, and present a per-subject comparison that distinguishes supported changes, prior mistakes, uncertainty, and no relevant update found. Store structured comparison claims and append corrections without rewriting originals.

### Acceptance criteria

- [ ] The answer visibly distinguishes what was said, what sources supported then, and what evidence supports now.
- [ ] Price comparisons reconcile plan, currency, billing period, seats, region, and tax basis; incompatible dimensions cannot produce an unqualified change.
- [ ] Missing historical support permits a current finding but not an invented change or an unsupported accusation that the prior answer was wrong.
- [ ] Evidence of a prior assistant mistake results in an explicit correction, not a claim that the vendor changed its offer.
- [ ] Corrections influence later references while exact recall preserves the original messages and provenance.
- [ ] Conflicting sources remain disclosed if dates and dimensions do not resolve them; no-change-found wording remains qualified.
- [ ] Significant updates explain relevance to stated user needs and every requested subject has a finding or explicit gap.
- [ ] Frozen evidence tests cover annual/monthly confusion, stale caches, contradictory official sources, and incorrectly asserted prior prices.

---

## Phase 7: Use attributed and reconstructed baselines

**User stories**: 23, 24, 26, 27.

**Dependencies**: Phase 6.

### What to build

A user supplies a personal quote, or asks a question whose original discussion lacks supporting historical evidence. Extend the comparison interaction to use attributed user baselines and evidence found today that explicitly describes the earlier period. Make the provenance visible in both the answer and inspection view.

### Acceptance criteria

- [ ] A user-provided quote can support an attributed comparison without being presented as an independently verified public price.
- [ ] A newly discovered dated source supporting the relevant earlier period can establish a visibly reconstructed baseline.
- [ ] A current-only page cannot establish a historical baseline just because the product or URL matches.
- [ ] Reconstruction does not modify the original answer's evidence or imply verification happened then.
- [ ] Conflicting reconstructed or user-reported baselines preserve attribution and uncertainty; comparison dimensions still apply.
- [ ] The full comparison remains inspectable after restart and reproducible with recorded evidence.

---

## Phase 8: Control recall and delete retained history

**User stories**: 40, 41, 42.

**Dependencies**: Phases 4–7 and phase 3 recovery.

### What to build

A user changes recall eligibility in the conversation interface or deletes a conversation. Future automatic historical preparation respects that choice immediately; durable cleanup removes dependent material while the UI distinguishes exclusion from deletion. Every later phase must extend this lifecycle to any new derived records it introduces.

### Acceptance criteria

- [ ] An excluded conversation remains directly accessible to its owner but cannot supply automatic context to other conversations.
- [ ] Eligibility changes prevent reuse through historical snapshots, caches, claims, and already selected references before publication.
- [ ] Deletion immediately denies access to originals, citations, events, and dependent context; cleanup status does not imply access remains permitted.
- [ ] Durable cleanup removes dependent material, including checkpoint content, and resumes after process restart.
- [ ] Concurrent research and background jobs cannot republish or recreate deleted content.
- [ ] Another owner cannot change recall preferences or delete a conversation through guessed identifiers.
- [ ] Tests verify that ordinary originals and bounded evidence persist without arbitrary expiry while operational logs follow shorter configurable retention.

---

## Phase 9: Find paraphrased history with hybrid retrieval

**User stories**: 10, 14, 15, 49, 50, 51, 57.

**Dependencies**: Phases 5 and 8; baseline evaluation fixtures established in earlier phases.

### What to build

A user refers to an earlier discussion with different wording and gets the right original context. Background indexing builds compatible embeddings; candidate fusion and conditional reranking improve discovery behind the existing history contract. Demonstrate the behavior with healthy indexing, incomplete indexing, and provider failure, then exercise a separate-generation migration against the same user queries.

### Acceptance criteria

- [ ] Paraphrased-reference fixtures retrieve the correct original exchange and complete shortlist through the existing UI, API, and history snapshot contract.
- [ ] Actual gateway embedding and rerank clients are integration-checked; dimensions, finite values, nonzero norms, and configured input modes are validated before indexing.
- [ ] Candidate filtering enforces owner, cutoff, and recall eligibility before ranking; source spans/hashes connect derived chunks to originals.
- [ ] Duplicate or partially failed indexing jobs do not duplicate records or advance progress past unfinished holes. Newly committed originals remain immediately available.
- [ ] Embedding failure yields lexical/original fallback with coverage disclosure; rerank failure retains fused ordering. Neither failure invents missing history.
- [ ] Different embedding spaces cannot mix even with equal dimensions. A new generation can be populated, evaluated, switched, and rolled back without corrupting the previous generation.
- [ ] Exclusion and deletion tests now cover chunks, vectors, generation work, and indexing races.
- [ ] Compare the new retrieval path with the lexical baseline using reference accuracy, candidate recall, complete-subject coverage, latency, and cost. Enable approximate indexing only if measured need and filtered under-return tests justify it.

---

## Phase 10: Research large histories without losing subjects

**User stories**: 7, 31, 48, 52, 53.

**Dependencies**: Phases 6 and 9.

### What to build

A user researches a multi-product shortlist amid a large history and oversized search results. Extend the already enforced per-call budget with evidence selection, continuity compaction, and bounded subject-level work. The UI still shows every required subject with supported findings or explicit gaps; summaries never replace authoritative originals or citations.

### Acceptance criteria

- [ ] Thousands of distracting exchanges and oversized tool results do not overflow the configured context envelope or silently remove a requested product.
- [ ] Every invocation, including summaries and repair attempts, accounts for instructions, schemas, message framing, evidence, output/reasoning allowance, and safety margin.
- [ ] A permitted smaller-context fallback triggers budget recomputation before invocation; incompatible capability assumptions prevent the fallback.
- [ ] Compaction preserves valid tool-call/result pairing, source provenance, and required subject coverage.
- [ ] Subject-level work shares one parent deadline and call/token budget rather than multiplying unrestricted work.
- [ ] Context failure allows only bounded recompilation; inability to fit becomes a visible limitation, clarification, or supported partial result.
- [ ] Traces record compaction and coverage decisions, and tests show exact recall still returns originals independently of model context size.

---

## Phase 11: Deliver partial findings and explicit continuation

**User stories**: 32, 33, 44, 52.

**Dependencies**: Phases 3, 6, and 10.

### What to build

A research run reaches its deadline or loses a dependency after finding some support. Present verified partial findings with named unfinished subjects and a continuation action. A continuation becomes a linked, separately admitted run with a fresh time anchor and budget while preserving the earlier evidence's actual observation times.

### Acceptance criteria

- [ ] The configured deadline and shared call/query/token/attempt limits stop new work and produce supported partial findings when available.
- [ ] Every requested subject is represented by a finding or named gap; absent supported findings result in an honest failure/limitation rather than invented partial content.
- [ ] The user explicitly continues through normal authorized admission, producing a new run linked to the incomplete one with a fresh time and budget.
- [ ] Continuation does not rewrite the prior final answer or silently reset its deadline. Duplicate continuation submissions remain idempotent.
- [ ] Reused findings retain provenance and freshness; deleted or excluded historical material is not revived through continuation ancestry.
- [ ] Foreground backpressure and separate indexing limits remain effective under dependency timeouts and bounded gateway retries.
- [ ] The UI and trace distinguish timeout, user cancellation, provider failure, and completed research with no relevant change found.

---

## Phase 12: Reproduce the complete local evaluation

**User stories**: 45, 46, 54, 55, 56, 57, 58.

**Dependencies**: Phases 1–11.

### What to build

A reviewer starts from a clean checkout, follows the local setup, and runs the three assignment scenarios through the real interface. Consolidate their persisted evidence, traces, deterministic regression results, bounded live quality checks, and local mocked load results into a reproducible evaluation and concise design explanation. This verifies the complete product path rather than introducing tests or telemetry for the first time.

### Acceptance criteria

- [ ] The clean-start walkthrough works with explicit gateway/search prerequisites, documents every needed credential, and never silently swaps fixtures into a live research interaction.
- [ ] The CRM shortlist, dated-question verification, and Postgres-hosting comparison scenarios recover the intended originals and produce evidence-qualified answers.
- [ ] All earlier release-blocking fixtures pass: ownership isolation, invalid citations, duplicate publication, vector incompatibility, omitted subjects, deletion races, and local recovery.
- [ ] Run the mocked workload of 100 connected clients and 10 active research turns with indexing. Report hardware, history size, payloads, cache conditions, acknowledgement/first-answer/completion p50/p95, errors, and backlog without implying hosted capacity.
- [ ] Exercise slow consumers, reconnect bursts, process crashes, and dependency outages under the local workload; report limitations rather than hiding failed targets.
- [ ] Separately record bounded live-provider compatibility and research-quality results with model/configuration versions, usage, and cost-estimation limits. Establish the experiment spend allocation before running the paid evaluation batch.
- [ ] Select and record numeric quality/latency/cost regression gates from baseline evidence before accepting optimization claims. Model judges supplement human-grounded numerical and historical fixtures.
- [ ] Verify redacted external traces, credential-free shared artifacts, and successful turns during telemetry outage. Unknown costs are labeled unknown.
- [ ] Produce the one-page design explanation from the implemented behavior and measured results, including tradeoffs and future work. Do not publish, deploy, or submit the repository as part of this phase without separate authorization.

## Completion boundary

Completion means all 12 phases have reproducible acceptance evidence and the local product meets the PRD. None of the unchecked criteria is satisfied merely by this plan or the earlier gateway smoke tests. Production identity, managed infrastructure, PostgreSQL multi-process concurrency, hosted backup/restore, multi-replica recovery, and service-level commitments remain outside this local plan.

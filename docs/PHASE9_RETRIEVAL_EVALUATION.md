# Phase 9 retrieval evaluation

## Deterministic fixture comparison

Run with `node --import tsx scripts/evaluate-history-retrieval.mjs`. The fixture contains one human-labeled CRM shortlist exchange and one paraphrased query. Embeddings and reranking are deterministic local stubs; no external model is called.

| Path | Reference accuracy at 1 | Candidate recall | Complete shortlist | One observed retrieval latency | External model cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| Lexical baseline | 0/1 | 0/1 | 0/5 (no candidate) | 2.98 ms | $0.00 |
| Hybrid retrieval | 1/1 | 1/1 | 5/5 | 10.42 ms | $0.00 |

This is a mechanism check on a single synthetic case, not a quality estimate or latency percentile. Its synthetic vector deliberately represents the paraphrase relationship; the result does not establish that a live embedding model retrieves CRM references at this rate. PGlite setup and indexing are excluded from the per-query latency; total setup and evaluation took 1463.33 ms on the observed run. Re-running the script reports fresh single-sample latencies.

The implementation retains exact JSONB cosine scoring with a 10,001-row scan cap and marks truncated or incompletely indexed retrieval as incomplete. No ANN index is enabled: this fixture supplies no measured scale or filtered under-return evidence that would justify approximation.

## Gateway integration check

A bounded synthetic check was run through the configured local LiteLLM gateway on 2026-11-16. Embeddings returned two distinct vectors with the configured dimension and validation passed. The rerank request was rejected with HTTP 400; gateway diagnostics attributed the Bedrock request to `INVALID_PAYMENT_INSTRUMENT` / Marketplace access. The current rerank integration therefore has a recorded provider-access failure. The retriever catches that failure and keeps reciprocal-rank-fusion order, which is covered by a deterministic test.

Do not interpret the embedding success as measured retrieval quality. Provider charges were not independently measured. The earlier successful rerank smoke test in [INFERENCE_VERIFICATION.md](INFERENCE_VERIFICATION.md) remains a historical result; it does not override this later failed request.

## Regression coverage

- `tests/history-index.test.ts`: paraphrase through original-backed chunks and snapshot contract, pre-ranking eligibility filtering, fallback coverage, vector-space isolation, generation activation/rollback, retry holes, and rerank failure.
- `tests/retrieval-inference.test.ts`: response ordering, dimensions, finite/nonzero/normalized vectors, input mode, and rerank response validation.
- `tests/recall-lifecycle.test.ts`: exclusion/deletion of indexed material and checkpoint cleanup recovery.
- `npm run test:research-browser`: paraphrased retrieval and snapshot inspection through the browser/API survived application restart.
- `tests/local-date.test.ts` and `tests/recall-flow.test.ts`: exact date recall and failed/no-match/incomplete distinctions.

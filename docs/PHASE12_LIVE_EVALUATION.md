# Phase 12 bounded live-provider evaluation

## Status

Prepared run protocol; **not executed**. No live model or search request, provider usage record, or bill has been collected for this evaluation. Do not attest the fast model as a fallback or mark the live Phase 12 criteria complete until a spend allocation is agreed and the evidence below is recorded.

The existing `test:research-browser` harness is deterministic and fixture-backed. It verifies application behavior but cannot establish live provider compatibility, research quality, or cost. The separate `fast-research-contract` verifier makes two billable model requests and uses synthetic evidence; it verifies the route contract, not the quality of web research.

## Bounded run order

1. Agree a hard experiment allocation covering both model inference and Tavily search. This allocation is a project authorization ceiling, not an account-level provider billing limit. Confirm that the configured account, region, and gateway route are the intended ones.
2. Run `node scripts/verify-inference.mjs fast-research-contract` against the configured LiteLLM gateway. On success, the script sends two model requests, with no application-level retries, no search calls, and synthetic evidence. A gateway may retry internally, so capture its retry behavior. Record both request usage objects, response model aliases, gateway route/config revision, configured model IDs, region, and timestamp. If either call fails or the response alias/configuration cannot be tied to the intended provider route, stop before the research scenarios and do not attest fallback capability.
3. Run the three assignment scenarios through an isolated application data directory with real configured search and inference providers. Reuse the documented CRM shortlist, 3 November Postgres, and last-Tuesday Postgres prompts from [the local evaluation report](PHASE12_LOCAL_EVALUATION.md). Cap each scenario at four model calls, two searches, 128 KiB cumulative serialized prompt bytes, and the existing run deadline. Do not retry a scenario or resume it without counting that work against the same allocation. The planned maximum is 12 scenario model calls and 6 Basic searches, in addition to the two route-check model calls.
4. Stop starting work when the allocation is reached or the planned request/search maxima are reached. Preserve partial results and report any unrun scenario as a gap. Reconcile gateway usage with provider-side usage/billing after provider records settle; do not infer billed cost from model aliases or latency.

The run is bounded by application call/query/prompt limits and a human-approved allocation, but those controls cannot prevent provider-side charges outside the observed gateway request path. Search cache state and cache hits must be recorded; a cache hit does not count as a provider search request.

## Required evidence per run

Record in a sanitized report, without credentials or raw prompts beyond the fixed public assignment prompts:

- UTC start/end time; source revision; runtime and dependency versions.
- LiteLLM route/config revision, confirmation that the intended provider account/region was used (without storing account identifiers), configured aliases and model IDs, and response model fields. A response alias alone is not proof of backend identity.
- Per-request input/output token usage as returned by the gateway, call count, retries, and any missing usage fields. Per search: provider, search depth, count, cache status, and credits if exposed.
- Provider billing/usage reconciliation and its observation timestamp. If unavailable, mark actual charge **unknown** and retain only a labeled estimate with the pricing source, region/tier assumptions, and excluded charges.
- Each scenario's completion status, requested-subject coverage, citations, source observation timestamps and representations, numeric price dimensions, historical-support outcome, uncertainty, and any safety or schema failure.
- Human-grounded rubric results and an independent model-judge assessment. Judges are supplementary and cannot override missing/mismatched source evidence.

Do not store API keys, account identifiers, private user content, or unredacted provider headers in the report. Keep detailed local evidence in ignored `.data/` storage; only publish sanitized aggregate results.

## Baseline regression gates

Treat the first complete bounded run as a baseline, not as proof of broadly representative quality. Gate the next comparable run against the same prompts, route, model/configuration revision, region, cache policy, and limits:

- **Research quality:** all five CRM subjects and both Postgres products have a finding or explicit gap; every factual current claim has a matching authorized citation; prices retain currency, plan, billing period, and material qualifiers; unsupported historical baselines remain explicitly unresolved. Any invented citation, unsupported historical change, missing requested subject, or silently omitted scenario fails the gate. Keep human scoring primary; report model-judge scores separately.
- **Usage and cost:** no run exceeds the approved allocation or the 14 model-request / 6 search-request maxima. Record total and per-scenario model tokens, search credits, and reconciled charge. Once a reconciled baseline exists, flag a greater-than-20% increase in normalized charge per completed scenario or model input/output tokens per completed scenario for review; fail only after accounting for a documented route, model, prompt, or provider-price change. Unknown actual charges cannot pass a cost regression gate.
- **Comparability:** a change in route, model ID, region, prompt/schema revision, search depth, or cache policy requires a new baseline; do not compare its raw cost or quality score as if the workload were unchanged.

The 20% cost tripwire is a review threshold, not a provider price guarantee. Tighten or revise it only after repeated reconciled runs show normal variance. Live quality/cost gates remain unset until the first approved run supplies the missing baseline.

# Phase 12 bounded live-provider evaluation

## Status and evidence

The bounded live batch completed on 2026-11-16 against source revision `51a470deacc44210dc71833da7dbb13d0b5a7c60`. The sanitized run artifact is `.data/live-research-evaluation-1794856431206.json` (ignored local data; do not commit). All three scenarios completed with nonempty cited answers. The application reported `all_scenarios_completed`; this is provider and harness completion, not a claim that every research question was resolved.

The application used LiteLLM 1.103.2 and Node 22.23.2. Main chat used Token Harbor `deepseek-v4.1-flash:free` through `chat-main-v1`; the configured retry fallback was AWS Bedrock `bedrock/converse/us.amazon.nova-micro-v1:0` through `chat-fast-v1`. Embeddings and reranking were not exercised by these scenarios. Tavily Basic performed live searches. The route configuration SHA-256 was `92eb2b6bcc7c7b75e2e768d757efe589e29ecadb655fc45dfb06ebfed3fef86d`.

| Scenario | Status | Model requests | Searches | Prompt bytes | Answer chars | Citations | Comparison result |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| CRM shortlist | Completed | 2 | 1 | 15,789 | 5,785 | 5 | Five subjects marked `historical_support_missing` |
| Dated Postgres question | Completed | 2 | 2 | 20,967 | 6,280 | 9 | Neon and Supabase `inconclusive` |
| Last-Tuesday Postgres question | Completed | 2 | 2 | 20,924 | 5,567 | 8 | Neon Launch and Supabase Pro `inconclusive` |
| **Total** | **3/3 completed** | **6** | **5** | **57,680** | **17,632** | **22** | Historical outcomes unresolved where source baselines were absent |

The final batch reported 12,567 prompt and 10,889 completion tokens across six model requests. All six used the main route; fallback was not invoked. Search cache was bypassed. Per-run application caps were four model requests, two searches, and 128,000 serialized prompt bytes; every scenario stayed below them. Earlier exploratory retries had transient provider and output-format failures and are outside these final-batch totals. They were user-authorized; no aggregate billed amount is inferred from the final report.

## Quality review

Manual review recommends **pass with scope limits** for the bounded baseline. Current factual claims in the final report have registered citations, the requested products remain represented, and unsupported historical baselines are labeled unresolved. The CRM scenario has source-coverage gaps for Acme CRM and Northstar CRM, and some price snippets omit currency or conflict across sources. The Postgres scenarios do not have source observations from the original conversations, so historical price or feature changes remain inconclusive. Search snippets are not a full-page audit, and same-day observations do not establish what was true earlier.

An independent Nova Micro model judge returned `pass_with_limitations`, but labeled historical safety as failed because original baselines were absent. Manual review treats that as a judge disagreement: the application explicitly leaves those comparisons unsupported instead of asserting a change. The judge is supplementary and cannot override missing or mismatched source evidence.

## Regression gates

Use this batch as a narrow baseline for the same prompts, routes, model IDs, configuration, region, search depth, and cache policy. A change to those conditions requires a new baseline.

- **Research quality:** human review remains primary. Require all requested subjects to have a cited finding or an explicit gap, factual claims to map to authorized evidence, price units and qualifications to be clear, and unsupported history to remain unresolved. Any invented citation, unsupported historical change, missing subject, or silently omitted scenario fails.
- **Usage:** retain the per-run limits of at most four model requests, two searches, and 128,000 prompt bytes. For a comparable three-scenario batch, flag a greater-than-20% increase in normalized model tokens or search requests per completed scenario for review, after accounting for documented route, model, prompt, or provider changes. These are usage proxies, not dollar-cost gates.
- **Billing:** actual Token Harbor, Tavily, and AWS charges remain unreconciled and are recorded as unknown. The user authorized paid checks and said available credits are sufficient, so missing billing reconciliation is not a blocker to completing this evaluation. Do not claim a monetary-cost pass or derive actual charges from aliases, token counts, or latency.

## Reproduction and limits

The live run used the existing three assignment prompts documented in [the local evaluation report](PHASE12_LOCAL_EVALUATION.md), an isolated application data directory, real Tavily Basic search, and the configured LiteLLM routes. The report contains no credentials or private conversation input. Re-run `npm run test:research-live` only after configuring local provider keys and gateway access; each run consumes provider usage.

Earlier exploratory retries are not part of the six-request/five-search final batch. Provider-side billing has not been reconciled. This is a small assignment-specific quality sample, not a broad research benchmark, source-page audit, hosted capacity test, or guarantee of future provider behavior.

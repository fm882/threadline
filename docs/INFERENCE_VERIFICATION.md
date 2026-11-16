# Local inference verification

Verified on **2026-11-15**, using the installed AWS CLI, an existing authorized profile, and a loopback LiteLLM process. The AWS source region was `us-east-1`. No cloud resources, IAM policies, subscriptions or payment settings were deliberately created or changed. Model calls are billable; exact AWS charges were not measured.

This report covers the local LiteLLM/Bedrock inference boundary only. The application, LangGraph workflow, temporal retrieval, source validation, persistence, and synthetic load evaluation have separate evidence; this report does not establish their correctness or hosted capacity. See [Phase 12 local evaluation](PHASE12_LOCAL_EVALUATION.md).

## Environment

| Component | Observed version/configuration |
| --- | --- |
| Node | 22.23.2 |
| AWS CLI | 2.36.17 |
| LiteLLM | 1.103.2 |
| Gateway | `http://127.0.0.1:4000` |
| Gateway persistence | None; local generated master-key authentication |
| AWS source region | `us-east-1` |
| Data | Synthetic short strings only |
| Retries | Verifier has no retries; gateway router retries configured to zero |

Credentials and machine-specific AWS profile names are intentionally omitted. The model catalog was inspected, but actual inference calls—not catalog visibility—establish the successful checks below. US inference profiles can route across their configured US regions.

## Results

| Check | Configured Bedrock backend | Result | Single observed duration |
| --- | --- | --- | ---: |
| Main text completion | `us.amazon.nova-pro-v1:0` | PASS: expected short text | 2724 ms |
| Fast streaming | `us.amazon.nova-micro-v1:0` | PASS: SSE content and terminal `[DONE]` | 2142 ms |
| Tool-call generation | `us.amazon.nova-pro-v1:0` | PASS: `web_search` call ID and valid JSON argument | 880 ms |
| Basic JSON-schema request | `us.amazon.nova-pro-v1:0` | PASS: expected `{ "ok": true }` object | 812 ms |
| Embeddings | `amazon.titan-embed-text-v2:0` | PASS: two distinct, finite, 1024-dimensional vectors with unit norms | 1477 ms |
| Reranking | `cohere.rerank-v3-5:0` via Bedrock | PASS: relevant CRM pricing document ranked first | 2029 ms |
| Unauthenticated model listing | Local gateway | PASS: HTTP 401 | Not benchmarked |

These durations are individual diagnostic samples, **not** latency percentiles, service-level guarantees or throughput measurements. The embeddings had norms approximately `1.000000025` and `1.000000040`. No full vectors are included in the shared report.

The text/stream/tool/schema calls used output limits of 64 or 128 tokens. The `web_search` tool was not executed. A valid small JSON response does not prove strict schema behavior on all inputs; schema validation remains mandatory in the application. Gateway response model fields returned logical aliases, so backend identities above come from the actual launcher/configuration used, not independent response-model attestation.

Embedding/reranking checks ran at approximately 13:46 UTC; Nova chat checks ran at approximately 13:48 UTC. Sanitized raw reports remain in ignored `.data/` files. No credentials, account IDs, private conversation text or full vectors are committed.

## Claude access failure

The initial candidate routes were:

- `us.anthropic.claude-sonnet-4-6` for main chat/tool/schema checks.
- `us.anthropic.claude-haiku-4-5-20251001-v1:0` for fast streaming.

Those four checks returned HTTP 403 with `INVALID_PAYMENT_INSTRUMENT`, indicating an account/Marketplace prerequisite prevented model access. This is not evidence that LangGraph, the OpenAI-compatible protocol, or LiteLLM cannot support Claude. Billing/subscription changes were not attempted.

The local defaults now use the accessible Nova models. Claude routes remain commented options in `.env.example`; they must be retested after account access is resolved. The Nova choice is an accessible development baseline, not a research-quality ranking against Claude or other models.

## Reproduce

Follow [the local gateway README](../infra/litellm/README.md). Start the gateway with an existing authorized AWS profile, then run:

```bash
node scripts/verify-inference.mjs
```

Use named checks to avoid repeating unrelated billable calls while debugging. Re-run after model/gateway configuration changes. Never use a different embedding model as an automatic fallback into the same vector space.

## Not established yet

- No final per-turn dollar cap or total evaluation budget has been set from these calls.
- No full live browser/LangGraph quality run or adversarial schema evaluation against a provider. The bounded `researchClient` tool-result continuation check is documented in [Phase 2 verification](PHASE2_VERIFICATION.md); deterministic cancellation/recovery fixtures are local tests.
- No web-search integration; no Tavily key or user conversation was used.
- No LangSmith export verification; real-user trace content remains disabled/redacted by policy.
- No database/vector-index integration, retrieval recall evaluation, or long-context test.
- No hosted capacity or provider latency load test. The separate 100-client/10-turn local synthetic measurement is in [Phase 12 local evaluation](PHASE12_LOCAL_EVALUATION.md).
- No cloud deployment, production identity, managed database or multi-replica validation.

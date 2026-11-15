# Local Bedrock inference through LiteLLM

This is local infrastructure and a reproducible inference check, not the implemented chat application. No cloud deployment or provisioning is needed. All actual inference still calls AWS Bedrock and can incur usage charges.

## Tested baseline

- Node 22.23.2 for these dependency-free helper scripts; the application runtime remains the documented supported LTS target.
- LiteLLM 1.103.2, with proxy dependencies, already installed in the current environment.
- Existing AWS CLI profile credentials; inference source region `us-east-1`.
- Main: `us.amazon.nova-pro-v1:0`.
- Fast: `us.amazon.nova-micro-v1:0`.
- Embeddings: `amazon.titan-embed-text-v2:0`, 1024 float dimensions; unit norms verified.
- Rerank: `cohere.rerank-v3-5:0` through the **Bedrock** rerank API.

The `us.` inference profiles may route within their configured US regions. This is not a claim that processing is confined to the source region. See [the verification report](../../docs/INFERENCE_VERIFICATION.md) for actual results and limitations.

## 1. Prerequisites

The Node backend is not replaced with Python. LiteLLM is a packaged third-party gateway that runs as a separate local process.

Check tools without exposing credentials:

```bash
node --version
aws --version
aws configure list-profiles
litellm --version
```

If LiteLLM is missing, install the tested proxy package in an isolated tool environment using `uv`:

```bash
uv tool install 'litellm[proxy]==1.103.2'
```

If an installation already exists, inspect its version before changing it. The helper can use another executable path through `LITELLM_BIN`; it does not install or upgrade packages automatically. Later version upgrades require rerunning the checks. Compatibility testing is not a security audit or an instruction to ignore security updates.

## 2. Configure

From the project root, copy `.env.example` to `.env` only if `.env` does not already exist. Select an existing authorized AWS profile through `AWS_PROFILE` in the shell or `.env` when the default is not appropriate. Never copy AWS access keys into the project.

```bash
cp -n .env.example .env
# Optional, using a profile you already have:
export AWS_PROFILE=your-existing-profile
```

The example file already contains the tested Nova/Titan/rerank routes. Claude route examples are commented because the tested account returned `INVALID_PAYMENT_INSTRUMENT` for Claude. Do not assume catalog visibility grants invocation permission.

The launcher reads `.env` using Node's built-in environment-file support. Shell environment overrides can be used for experiments without editing tracked configuration. `AWS_REGION_NAME` must match the selected routes and rerank model ARN. Changing only the region does not make every route available there.

## 3. Start the local gateway

```bash
node scripts/start-gateway.mjs
```

It binds only to `127.0.0.1:4000`, uses [config.yaml](config.yaml), and creates `.data/litellm.key` with mode 0600 when no explicit `LITELLM_MASTER_KEY` is supplied. `.data/` and `.env` are ignored by Git. The key is never printed. Stop the foreground launcher with Ctrl-C.

No gateway database is configured. LiteLLM's no-database authentication accepts its master key, so the local verifier uses that key. **This is a single-user, loopback-only development exception.** Never expose this process remotely or give that key to a browser. A future deployed gateway must use scoped credentials and an appropriate control-plane configuration.

Optional `LITELLM_PORT` changes the listen port. If changed, also update `INFERENCE_BASE_URL` and `RERANK_URL` for the verifier/application. Existing services on the port are not stopped automatically.

## 4. Run bounded live checks

In a second terminal:

```bash
node scripts/verify-inference.mjs
```

The complete pass sends six logical requests, with embeddings containing two short input strings (the gateway may perform more than one provider invocation). Chat outputs are capped at 64 or 128 tokens. Client and gateway retries are disabled for this check. Only synthetic text is used; no web search is executed and no user conversation is sent.

Checks:

1. Main-model text completion.
2. Fast-model SSE completion and terminal event.
3. A generated `web_search` function call with valid JSON arguments; the tool is not executed.
4. A basic strict JSON-schema output request producing the expected object.
5. Two embeddings with correct order, finite values, 1024 dimensions, unit norm, and different vectors.
6. Reranking two documents with the relevant document first.

Run individual checks when diagnosing a failure, avoiding repeated unnecessary calls:

```bash
node scripts/verify-inference.mjs main-chat fast-stream
node scripts/verify-inference.mjs embeddings rerank
```

The script exits nonzero if any selected check fails and writes a sanitized JSON report under `.data/`. Reports omit keys, full vectors, account identity and private input. Review reports before sharing. The tests establish basic HTTP/model compatibility, not reasoning quality, reliable schema adherence across adversarial inputs, full LangChain/LangGraph integration, search correctness or production readiness.

## Failure interpretation

| Failure | Meaning / response |
| --- | --- |
| `INVALID_PAYMENT_INSTRUMENT` | Account/Marketplace access prerequisite for that model; no amount of application retries fixes it. Use an already accessible model or resolve account billing separately. |
| 401 from local proxy | Key mismatch; verifier should use the generated file or the same explicit environment key. |
| AWS expired credentials/access denied | Refresh the existing profile through your normal process or inspect permissions; do not embed secrets in config. |
| Missing model / invalid profile | Verify the source region and route; list results alone do not prove invocation access. |
| Port already in use | Choose a free port and update both client URLs; do not kill an unrelated process. |
| Embedding dimension/norm mismatch | Reject the result and investigate configuration; do not silently alter the active vector index. |

No IAM permissions, subscriptions, payment details, AWS resources or remote services are changed by the helper scripts. Live calls do exercise account model access and incur normal inference usage.

## Sources

- [LiteLLM configuration](https://docs.litellm.ai/docs/proxy/configs)
- [Bedrock provider integration](https://docs.litellm.ai/docs/providers/bedrock)
- [Bedrock embeddings](https://docs.litellm.ai/docs/providers/bedrock_embedding)
- [Bedrock reranking](https://docs.litellm.ai/docs/providers/bedrock_rerank)

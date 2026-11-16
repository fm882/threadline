# Threadline

**A time-aware research agent that remembers the discussion, checks current sources, and shows what changed.**

Threadline retrieves an earlier conversation, searches current sources, and keeps “what we said,” “what sources supported then,” and “what the evidence supports now” distinct. If an earlier source baseline is missing, it says so rather than inventing a change.

The local implementation and evaluation are described in the [PRD](PRD.md), [implementation plan](plans/time-aware-research-agent.md), and [live evaluation report](docs/PHASE12_LIVE_EVALUATION.md).

## Quick start

### Requirements

- Node.js 22 or newer and npm.
- An OpenAI-compatible HTTPS inference endpoint and a key accepted by that endpoint.
- A Tavily API key for live web search.

No particular model provider is required. “OpenAI-compatible” describes the API protocol, not a requirement to use OpenAI; use any provider that implements the API features Threadline calls. Live web search currently uses Tavily. LiteLLM is optional; see [Using LiteLLM](#optional-using-litellm) below.

### Install

```bash
npm install
cp -n .env.example .env
```

Edit `.env` and configure your inference endpoint and search key:

```dotenv
INFERENCE_BASE_URL=https://your-provider.example/v1
INFERENCE_API_KEY=your-provider-api-key
CHAT_MAIN_MODEL=your-model-id
TAVILY_API_KEY=your-tavily-api-key
```

`INFERENCE_BASE_URL` is the API base URL, including `/v1` when required by the provider. Remote endpoints must use HTTPS. Keep keys in `.env`; do not put them in browser code, URLs, or commits. If using a local gateway, the default `INFERENCE_BASE_URL` is `http://127.0.0.1:4000/v1`, and the app reads the generated local gateway key automatically.

### Check provider compatibility

Threadline expects the inference service to:

- Advertise `CHAT_MAIN_MODEL` from `GET /models`.
- Support streaming chat completions, tool calls, and structured JSON output at `POST /chat/completions`.
- Support the model and capability settings in [`config/model-capabilities.json`](config/model-capabilities.json). The main model must match `CHAT_MAIN_MODEL`; update both together when using a different model ID.
- Provide `POST /embeddings` on the same `INFERENCE_BASE_URL` if you want semantic history search. Set `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_NORMALIZED`, and a unique `EMBEDDING_SPACE_ID` to match that model. Keep an embedding space ID stable for one model/dimension/normalization configuration; create a new ID when changing spaces.

The checked-in capability manifest also enables a verified fast fallback. For a provider setup without a fallback, remove the `chatFallback` entry from the manifest. If you configure a fallback, its model must be advertised at `/models`, the `CHAT_FAST_MODEL` value must match it, and the manifest must reflect verified route capabilities.

Reranking is optional. If your provider or a separate service offers a compatible reranker, set `RERANK_URL`, `RERANK_MODEL`, and, when it uses a separate remote host, `RERANK_API_KEY`. The reranker must accept Threadline’s `{ model, query, documents, top_n }` request and return ranked results with `index` and `relevance_score`. Reranking is not part of the OpenAI API standard; when it is unavailable, Threadline keeps its fused retrieval order.

See [`.env.example`](.env.example) for all application environment variables and defaults. In addition to the variables above, the main settings are:

| Variable | Needed when | Purpose |
| --- | --- | --- |
| `INFERENCE_BASE_URL` | Always | OpenAI-compatible API base; defaults to the local LiteLLM endpoint. |
| `INFERENCE_API_KEY` | Remote inference endpoint | Authenticates chat and embedding requests. Leave unset for local LiteLLM, which reads its generated key. |
| `CHAT_MAIN_MODEL` | Always | Main chat model ID; must match the capability manifest and provider model listing. |
| `CHAT_FAST_MODEL` | Fallback enabled | Fallback model ID; must match the manifest and provider model listing. |
| `TAVILY_API_KEY` | Live web research | Enables current-source search. Without it, live search is unavailable. |
| `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_NORMALIZED`, `EMBEDDING_SPACE_ID` | Semantic history search | Select the model and immutable vector space. Dimensions and normalization must match the provider. |
| `RERANK_URL`, `RERANK_MODEL` | Reranking | Configure the optional compatible reranker. Set `RERANK_API_KEY` for a separate remote endpoint. |
| `TOKENHARBOR_API_KEY` | Optional bundled LiteLLM config | Authenticates the example Token Harbor main-chat route; replace it with the key for whichever provider route you configure. |
| `AWS_PROFILE`, `AWS_REGION_NAME`, `BEDROCK_*_ROUTE` | Optional Bedrock routes | Select existing AWS credentials, region, and Bedrock model routes. These are not needed for other providers. |
| `LITELLM_PORT`, `LITELLM_BIN`, `LITELLM_MASTER_KEY` | Optional LiteLLM setup | Change the local port/executable/key. The launcher generates a local key and uses port 4000 by default. |

### Run

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The API listens on `127.0.0.1:3000`; Vite proxies API and health requests. Readiness is at <http://127.0.0.1:5173/health/ready> and liveness is at <http://127.0.0.1:5173/health/live>. Stop the development server with Ctrl-C.

Select **Verify current information with fresh search** to bypass the short search cache. Conversations, evidence, embeddings, and checkpoints are stored locally under `.data/`. The local app uses a single identity and is not a hosted multi-user deployment.

## Optional: using LiteLLM

Use LiteLLM when you want one local gateway to route across providers, normalize their APIs, or configure fallbacks. It is not required when your direct endpoint already meets the contracts above.

The repository includes a tested example configuration: Token Harbor for main chat, AWS Bedrock Nova Micro for the fallback, Titan for embeddings, and Cohere for reranking. To use those example routes, configure `TOKENHARBOR_API_KEY` and the AWS credential chain for the Bedrock routes you enable. You can replace them with other LiteLLM-supported providers by editing `infra/litellm/config.yaml` and setting those providers' credentials. Provider-specific keys and credentials are only needed for their corresponding routes; they are not universal Threadline requirements.

If LiteLLM Proxy is not installed, install the tested version with `uv`:

```bash
uv tool install 'litellm[proxy]==1.103.2'
litellm --version
```

Copy `.env.example` to `.env` as shown above, set the credentials for the routes in [`infra/litellm/config.yaml`](infra/litellm/config.yaml), and start the gateway:

```bash
node scripts/start-gateway.mjs
```

It listens on `127.0.0.1:4000` and creates `.data/litellm.key`. Keep it loopback-only for local development. In a second terminal, run `npm run dev`; the default inference URL already points at this gateway. See the [gateway setup guide](infra/litellm/README.md) and [LiteLLM Proxy documentation](https://docs.litellm.ai/docs/proxy/quick_start) for route configuration.

## Verify

```bash
npm test
npm run typecheck
npm run build
npm run test:research-browser
```

Browser research tests use local fixtures and do not call external providers. `npm run evaluate:local-load` runs the synthetic 100-client/10-turn workload. `npm run test:research-live` uses configured live providers and consumes provider usage. See the [evaluation report](docs/PHASE12_LIVE_EVALUATION.md) for the completed baseline and its limits.

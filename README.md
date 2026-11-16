# Threadline

**A time-aware research agent that remembers the discussion, checks current sources, and shows what changed.**

Threadline is a local-first chat app for questions such as “What did we shortlist last Monday, and has the pricing changed?” It retrieves the original discussion, searches current sources, and keeps “what we said,” “what sources supported then,” and “what the evidence supports now” distinct. When an earlier source baseline is missing, it says so instead of inventing a change.

The project implements the local acceptance plan in [the PRD](PRD.md) and [implementation plan](plans/time-aware-research-agent.md). The live research evaluation and its quality and billing limits are in [the Phase 12 report](docs/PHASE12_LIVE_EVALUATION.md).

## Quick start

### Requirements

- Node.js 22 or newer and npm.
- A Token Harbor API key for main chat.
- A Tavily API key for live web search.
- Access to AWS Bedrock through an existing AWS credential profile for the verified fallback and embeddings. Cohere reranking is configured, but may require separate Bedrock Marketplace access; if it fails, retrieval continues with fused ranking.
- LiteLLM Proxy, installed locally as described below.

The default configuration uses Token Harbor `deepseek-v4.1-flash:free` for main chat, AWS Bedrock Nova Micro as the retry fallback, Titan Text Embeddings V2 for history embeddings, Cohere Rerank 3.5 when account access permits, and Tavily Basic for web search. Provider keys stay on the server or gateway; never put them in browser code or commit them.

### Install and configure

```bash
npm install
cp -n .env.example .env
```

Edit the ignored `.env` file and set:

```dotenv
TOKENHARBOR_API_KEY=your-token-harbor-key
TAVILY_API_KEY=your-tavily-key
```

The Bedrock routes use the AWS credential chain. If your default profile is not the authorized one, select an existing profile in your shell:

```bash
export AWS_PROFILE=your-existing-profile
aws configure list-profiles
```

Set `AWS_PROFILE` to a profile listed by the command. See [`.env.example`](.env.example) for optional route, region, gateway, and application settings.

### Install and start LiteLLM

LiteLLM is the local gateway that combines the Token Harbor chat route with the Bedrock fallback, embedding, and reranking routes. If the `litellm` executable is not already installed, install the version used for this evaluation with `uv`:

```bash
uv tool install 'litellm[proxy]==1.103.2'
litellm --version
```

Start the gateway in the first terminal:

```bash
node scripts/start-gateway.mjs
```

It listens on `127.0.0.1:4000`, reads `infra/litellm/config.yaml`, and creates a local gateway key at `.data/litellm.key`. It binds to loopback for single-user development; do not expose it to a network.

### Start Threadline

In a second terminal, from the project root:

```bash
npm run dev
```

Open <http://127.0.0.1:5173>. The API listens on `127.0.0.1:3000`; Vite proxies API and health requests. Readiness is at <http://127.0.0.1:5173/health/ready> and liveness is at <http://127.0.0.1:5173/health/live>. Stop the app and gateway with Ctrl-C in their terminals.

Select **Verify current information with fresh search** when you need an explicit current check; this bypasses the short search cache. Without `TAVILY_API_KEY`, live web research is unavailable and the app must disclose that limitation.

## Do I need LiteLLM?

Not inherently. An application can call providers directly when their endpoints implement every API contract it needs. This project’s tested default uses LiteLLM because its providers differ: Token Harbor serves main chat, while Bedrock supplies the fallback, embeddings, and reranking.

To remove LiteLLM and keep all Threadline features, a direct endpoint or another gateway must satisfy the app’s full contracts:

- `GET /models` must advertise the configured main and verified fallback model aliases.
- `POST /chat/completions` must support the app’s streaming, tool-call, and structured JSON requests.
- `POST /embeddings` must return the configured vector dimensions and normalization for the same embedding space used by existing history indexes. The current app uses `INFERENCE_BASE_URL` and `INFERENCE_API_KEY` for both chat and embeddings.
- The reranker must implement Threadline’s separate `/rerank` request/response contract. Reranking is not part of the OpenAI API standard; configure `RERANK_URL` and, for a different remote host, `RERANK_API_KEY`.

The checked-in capability manifest is bound to the verified Nova Micro fallback route. A direct-provider setup that changes those aliases or routes also needs a matching capability configuration and fresh compatibility checks. A chat-only OpenAI-compatible endpoint does not replace all the current LiteLLM routes.

For a remote OpenAI-compatible gateway, set `INFERENCE_BASE_URL` to its HTTPS base URL and `INFERENCE_API_KEY` in `.env`. The remote endpoint must meet the requirements above; Threadline will not send the local LiteLLM key to it. See [the gateway setup guide](infra/litellm/README.md) and [LiteLLM Proxy documentation](https://docs.litellm.ai/docs/proxy/quick_start).

## Data and privacy

Conversations, source observations, embeddings, and checkpoints are stored locally under `.data/`. Delete a conversation in the UI to remove its retained history and dependent material. Operational progress events have a shorter retention period, configurable with `OPERATIONAL_EVENT_RETENTION_DAYS` (default `30`). The default gateway is loopback-only and the app uses a single local identity; this is not a hosted multi-user deployment.

## Verify the project

```bash
npm test
npm run typecheck
npm run build
npm run test:research-browser
```

The browser research tests use local fixtures and do not call paid providers. `npm run evaluate:local-load` runs the synthetic 100-client/10-turn workload. For an explicitly authorized live provider run, configure the keys and gateway, then run `npm run test:research-live`; live runs consume provider usage. The [evaluation report](docs/PHASE12_LIVE_EVALUATION.md) records the completed baseline and its limits.

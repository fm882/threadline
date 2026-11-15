# Phase 2 verification in progress

`npm run test:research-browser` runs a Chrome interaction through the application API and checkpointed graph using recorded model and search responses. It verifies citation inspection before and after server restart. The fixture uses a fixed observation time and does not establish live provider quality. `tests/research-client.test.ts` exercises tool-result pairing, invented IDs, and model-authored citation markup.

The remaining Phase 2 criteria are not complete. In particular, live provider continuation, broader freshness policy, and enforcement of price qualification need further evidence.

On 2026-11-15, `node --import tsx scripts/verify-research.mjs` sent two bounded model calls through local LiteLLM and the configured Bedrock model, with a synthetic search result. The model requested search and returned one citation that passed run-scoped validation. An earlier attempt omitted tools from the continuation and LiteLLM reported converting tool blocks to text; the corrected run retained the tool definition and did not emit that warning. This does not verify the live Tavily provider or model quality.

The browser fixture verifies progress appears before the answer and that HTML and Markdown in a claim and source excerpt render as inert text. The research-client tests also cover an unavailable search provider and confirm no model continuation is made after the failure. These are recorded-response tests, not live Tavily verification.

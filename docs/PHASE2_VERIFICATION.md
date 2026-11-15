# Phase 2 verification in progress

`npm run test:research-browser` runs a Chrome interaction through the application API and checkpointed graph using recorded model and search responses. It verifies citation inspection before and after server restart. The fixture uses a fixed observation time and does not establish live provider quality. `tests/research-client.test.ts` exercises tool-result pairing, invented IDs, and model-authored citation markup.

The remaining Phase 2 criteria are not complete. In particular, live provider continuation, broader freshness policy, and enforcement of price qualification need further evidence.

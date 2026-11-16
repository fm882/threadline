# Phase 11 continuation evidence

## Implemented behavior

- A run that exceeds its configured execution deadline ends as `incomplete`, with a durable assistant limitation message and an `incomplete` terminal event. Late model output is ignored. Provider errors, user cancellation, and successful publication keep their separate terminal statuses and trace stages.
- The UI offers **Continue research** for an incomplete assistant turn. The endpoint checks ownership and source-history eligibility, uses ordinary turn admission with a new idempotency key, creates a new run linked through `parent_run_id`, and retains the original run unchanged. Replaying the same key and input returns the same child run; changing the input conflicts.
- A continuation starts a fresh run and therefore receives a new execution deadline. It receives the original question by default, or a bounded replacement input when supplied. It does not import partial claims, tool results, or evidence from the parent. Source snapshots are checked for revocation before a child can be admitted.
- Each research run stores its first-attempt deadline and cumulative work counters. Worker recovery cannot reset them. The current hard limits are two execution attempts, four model calls, two searches, and 128,000 serialized prompt bytes across attempts. Model calls also disable SDK retries; each search has a ten-second request timeout. These byte counts are a conservative tokenizer-independent cost proxy, not provider-reported token usage. Traces record the budget state at worker start.
- The timeout message currently says that no supported partial findings are available. This is accurate for the current all-or-nothing research client: its final structured response is validated as a whole before claims are publishable.

## Verification

- `npm run typecheck`
- `npm test -- tests/continuation.test.ts tests/chat.test.ts tests/api.test.ts tests/recovery.test.ts tests/history-context.test.ts` — 5 files, 41 tests passed.
- `npm test` — 29 files, 143 tests passed after adjusting shared recovery headroom for the existing crash-during-tool-result fixture.
- `npm run test:research-browser` — passed after the latest API response assertion; demonstrated the deadline limitation, explicit continuation action, linked child run, and completed child status after restart.
- A durable budget regression verifies the deadline and all cumulative limits survive the second worker attempt; process recovery verified the bounded retry can finish a tool-result continuation.

## Remaining work

Phase 11 is not complete. Serialized prompt bytes proxy for token cost and should not be reported as provider token usage. The application cannot yet publish validated per-subject findings when work times out midway, and the incomplete answer does not enumerate subject-level gaps. The dependency-timeout/backpressure combination also needs a targeted regression run. Do not treat the current generic limitation as satisfying those acceptance criteria.

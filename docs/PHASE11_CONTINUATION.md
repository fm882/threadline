# Phase 11 continuation evidence

## Implemented behavior

- A run that exceeds its configured execution deadline ends as `incomplete`, with a durable assistant limitation message and an `incomplete` terminal event. Late model output is ignored. Provider errors, user cancellation, and successful publication keep their separate terminal statuses and trace stages.
- The UI offers **Continue research** for an incomplete assistant turn. The endpoint checks ownership and source-history eligibility, uses ordinary turn admission with a new idempotency key, creates a new run linked through `parent_run_id`, and retains the original run unchanged. Replaying the same key and input returns the same child run; changing the input conflicts.
- A continuation starts a fresh run and therefore receives a new execution deadline. It receives the original question by default, or a bounded replacement input when supplied. It does not import partial claims, tool results, or evidence from the parent. Source snapshots are checked for revocation before a child can be admitted.
- The timeout message currently says that no supported partial findings are available. This is accurate for the current all-or-nothing research client: its final structured response is validated as a whole before claims are publishable.

## Verification

- `npm run typecheck`
- `npm test -- tests/continuation.test.ts tests/chat.test.ts tests/api.test.ts tests/recovery.test.ts tests/history-context.test.ts` — 5 files, 41 tests passed.
- `npm run test:research-browser` — passed after the latest API response assertion; demonstrated the deadline limitation, explicit continuation action, linked child run, and completed child status after restart.

## Remaining work

Phase 11 is not complete. There is not yet one shared parent budget for elapsed time, model calls, search queries, tokens, and attempts; only the run deadline, bounded model/tool flow, and durable retry cap apply. The application cannot yet publish validated per-subject findings when work times out midway, and the incomplete answer does not enumerate subject-level gaps. The dependency-timeout/backpressure combination also needs a targeted regression run. Do not treat the current generic limitation as satisfying those acceptance criteria.

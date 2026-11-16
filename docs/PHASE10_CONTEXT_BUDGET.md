# Phase 10 context budget implementation

The local capability manifest supplies the context ceiling. Each chat invocation reserves the configured 1,024 output tokens and a 2,048-unit safety allowance. The prompt compiler measures serialized UTF-8 payload size, adds message framing, and counts schemas/tool definitions and evidence payloads. This is a conservative tokenizer-independent proxy, not a tokenizer count; no per-model tokenizer has been configured.

When a prompt exceeds its envelope, the compiler removes only the oldest complete user/assistant exchanges. It retains system instructions, historical source context, and the current user request. Research calls recompile both the tool-call request and the continuation containing the tool result; the tool result, assistant tool call, structured-output instructions, and tool schema remain in the measured payload. An oversized required prompt becomes a visible limitation; content is not silently truncated. The application has no smaller-context fallback configured, and it does not issue summary or repair calls.

The same research run signal and outer 60-second deadline bound both model invocations and search. Subject comparisons remain in one structured response with one shared output allowance, and validation requires one result or explicit gap per reported requested subject. Traces record context compaction cost, removed exchange count, and history coverage state without recording source text.

`tests/context-budget.test.ts` exercises 1,000 distracting exchanges, preservation of the required subject list and current question, schema overhead, complete tool-call/result retention, and visible overflow. `tests/history-context.test.ts` verifies that an oversized original is not sent to the model and produces a visible limitation. `tests/tracing.test.ts` verifies the redacted budget and coverage decision metadata.

This slice does not establish model-tokenizer accuracy, a smaller-model fallback, retrieval quality under large histories, or measured concurrency. Those checks remain part of the full Phase 10 and Phase 12 acceptance work.

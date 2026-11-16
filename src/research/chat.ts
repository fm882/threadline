import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { RunBudgetExceeded, Store, type ComparisonClaim } from '../persistence/store.js';
import type { HistoryRetriever } from '../history/index.js';
import { traceTurn, type TraceSink } from '../telemetry/tracing.js';
import { requiresCurrentVerification } from './freshness.js';
import { prepareExactRecall } from '../history/recall.js';
import { historicalContextPrompt, prepareHistoricalContext } from '../history/context.js';
import { compactChatMessages, ContextBudgetError, serializedPromptBudgetCost } from './context-budget.js';
import { z } from 'zod';

export type ChatMessage = { role: string; content: string };
export type ChatOutput = string | { content: string; claims: { claim: string; evidenceIds: string[] }[]; comparisons?: ComparisonClaim[] };
export type ChatClient = (messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal) => Promise<ChatOutput>;

export const MAX_INPUT_CHARS = 8_000;

export function gatewayClient(baseURL: string, apiKey: string, model: string, verifyCurrent = false, reserveModelCall?: (promptBytes: number) => Promise<unknown>): ChatClient {
  const client = new ChatOpenAI({ model, apiKey, configuration: { baseURL, fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) }, maxTokens: 1024, maxRetries: 0, timeout: 65_000 });
  return async (messages, onChunk, signal) => {
    if (verifyCurrent || requiresCurrentVerification(messages[messages.length - 1]?.content || '')) {
      return 'Web search is not configured, so I cannot verify current information.';
    }
    const historicalContext = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const conversation = messages.filter(message => message.role !== 'system').map(m => m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content));
    const system = `Web search is unavailable. For questions requiring current or externally verified information, clearly say you cannot verify it rather than presenting an unverified current claim.${historicalContext ? `\n\n${historicalContext}` : ''}`;
    const prompt = [new SystemMessage(system), ...conversation];
    await reserveModelCall?.(serializedPromptBudgetCost(prompt));
    const stream = await client.stream(prompt, { signal });
    let result = '';
    for await (const chunk of stream) {
      if (typeof chunk.content !== 'string') throw new Error('Unsupported response format');
      result += chunk.content;
      if (result.length > 32_000) throw new Error('Output limit exceeded');
      if (chunk.content) onChunk(chunk.content);
    }
    if (!result.trim()) throw new Error('Empty model response');
    return result;
  };
}

async function invokeWithinDeadline(client: ChatClient, messages: ChatMessage[], onChunk: (chunk: string) => void, timeoutMs: number, externalSignal?: AbortSignal) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
  if (signal.aborted) throw new Error('Cancelled');
  try {
    return await Promise.race([
      client(messages, chunk => { if (!signal.aborted) onChunk(chunk); }, signal),
      new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('Cancelled'));
        else signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { reject(new Error('Deadline exceeded')); controller.abort(); }, timeoutMs);
      }),
    ]);
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
  }
}

const checkpointAnswerSchema = z.union([
  z.string().min(1).max(32_000),
  z.object({ content: z.string().min(1).max(50_000), claims: z.array(z.object({ claim: z.string().min(1).max(5000), evidenceIds: z.array(z.string().uuid()).min(1).max(5) })).max(10), comparisons: z.array(z.any()).max(10).optional() }),
]);

export async function checkpointAnswer(checkpointer: SqliteSaver, runId: string): Promise<ChatOutput | null> {
  const checkpoint = await checkpointer.get({ configurable: { thread_id: runId } });
  if (!checkpoint || checkpoint.channel_values.answer === undefined) return null;
  return checkpointAnswerSchema.parse(checkpoint.channel_values.answer);
}

const State = Annotation.Root({ messages: Annotation<ChatMessage[]>(), answer: Annotation<ChatOutput>() });

export function createChatRunner(store: Store, checkpointer: SqliteSaver, client: ChatClient, onChunk: (run: string, chunk: string) => void = () => {}, sink?: TraceSink, deadlineMs = 60_000, retrieve?: HistoryRetriever, contextTokens = 32_000) {
  return async (owner: string, run: string, signal?: AbortSignal) => {
    const record = await store.getRun(owner, run);
    if (record.status !== 'active') return;
    const trace = traceTurn(run, sink, new Date(record.created_at).getTime());
    let deadlineController: AbortController | undefined;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let runSignal = signal;
    try {
      const saved = await checkpointAnswer(checkpointer, run);
      if (saved !== null) {
        signal?.throwIfAborted();
        if (await store.publish(owner, run, typeof saved === 'string' ? saved : saved.content, typeof saved === 'string' ? [] : saved.claims, typeof saved === 'string' ? [] : saved.comparisons || [])) trace.stage('publication');
        return;
      }
      if (!await store.beginAttempt(owner, run, 2, deadlineMs)) {
        await store.fail(owner, run, 'The run could not be resumed within its attempt limit. Please start a new turn.');
        return;
      }
      const budget = await store.researchBudget(owner, run);
      deadlineController = new AbortController();
      const remainingMs = Math.max(0, new Date(budget.deadline_at).getTime() - Date.now());
      deadlineTimer = setTimeout(() => deadlineController?.abort(new Error('Deadline exceeded')), remainingMs);
      runSignal = signal ? AbortSignal.any([signal, deadlineController.signal]) : deadlineController.signal;
      trace.decision('research_budget', { modelCalls: budget.model_calls, searchQueries: budget.search_queries, promptBytes: budget.prompt_bytes, remainingMs });
      const { current, history: prior } = await store.context(owner, run);
      const recall = await prepareExactRecall(store, owner, run, current.content, new Date(record.created_at), record.timezone);
      if (recall !== null) {
        runSignal?.throwIfAborted();
        if (await store.publish(owner, run, recall)) trace.stage('publication');
        return;
      }
      const continuity = prior.slice(-8).map(message => message.content).join('\n').slice(-8_000);
      const reference = await prepareHistoricalContext(store, owner, run, current.content, new Date(record.created_at), record.timezone, continuity, retrieve);
      if (reference.kind === 'resolved') {
        trace.stage(reference.coverage === 'complete' ? 'history_coverage_complete' : 'incomplete_coverage');
        trace.decision('history_coverage', { complete: reference.coverage === 'complete' });
      }
      if (reference.kind === 'clarification_needed') {
        runSignal?.throwIfAborted();
        if (await store.publish(owner, run, `${reference.question}\n[reference:${reference.snapshotId}]`)) trace.stage('publication');
        return;
      }
      if (reference.kind === 'no_match') {
        runSignal?.throwIfAborted();
        if (await store.publish(owner, run, 'I could not find a matching earlier discussion in the retained history available to this run.')) trace.stage('publication');
        return;
      }
      if (reference.kind === 'incomplete') {
        runSignal?.throwIfAborted();
        if (await store.publish(owner, run, 'I could not search the retained history completely, so I cannot determine which discussion you meant. Please try again with a topic or date.')) trace.stage('publication');
        return;
      }
      const selected: ChatMessage[] = [];
      // Select whole prior user/assistant pairs from newest to oldest.
      for (let i = prior.length - 1; i > 0; i -= 2) {
        const user = prior[i - 1], assistant = prior[i];
        if (user.role !== 'user' || assistant.role !== 'assistant') break;
        selected.unshift({ role: user.role, content: user.content }, { role: assistant.role, content: assistant.content });
      }
      let referenceSnapshotId: string | null = null;
      if (reference.kind === 'resolved') {
        const snapshot = await store.referenceSnapshot(owner, reference.snapshotId);
        const source = snapshot.items[0];
        if (!source) {
          if (await store.publish(owner, run, 'I could not verify the original discussion in the retained history, so I cannot use it. Please try again.')) trace.stage('publication');
          return;
        }
        const coverage = snapshot.coverage === 'complete' && reference.coverage === 'complete' ? 'complete' : 'incomplete';
        const context = historicalContextPrompt({ ...source, score: 0 }, coverage, reference.discussionDate, reference.comparisonDate);
        selected.push({ role: 'system', content: context });
        if (coverage === 'incomplete') trace.stage('incomplete_coverage');
        referenceSnapshotId = reference.snapshotId;
      }
      selected.push({ role: 'user', content: current.content });
      if (current.content.length > MAX_INPUT_CHARS) throw new Error('Input exceeds context limit');
      const compiled = compactChatMessages(selected, { contextTokens, outputTokens: 1024, safetyTokens: 2048 }, [{ systemReserve: 'Web search availability and safety instructions', toolSchemaReserve: 512 }]);
      if (compiled.removedPairs) trace.stage('compaction');
      trace.decision('context_budget', { removedPairs: compiled.removedPairs, inputCost: compiled.inputCost, availableCost: compiled.availableCost });
      selected.splice(0, selected.length, ...compiled.messages);
      runSignal?.throwIfAborted();
      trace.stage('inference');
      const graph = new StateGraph(State)
        .addNode('chat', async state => ({ answer: await invokeWithinDeadline(client, state.messages, chunk => onChunk(run, chunk), Math.max(1, new Date(budget.deadline_at).getTime() - Date.now()), runSignal) }))
        .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer });
      const output = await graph.invoke({ messages: selected }, { configurable: { thread_id: run } });
      runSignal?.throwIfAborted();
      const answer = typeof output.answer === 'string' ? output.answer : output.answer.content;
      const published = referenceSnapshotId ? `${answer}\n[reference:${referenceSnapshotId}]` : answer;
      if (await store.publish(owner, run, published, typeof output.answer === 'string' ? [] : output.answer.claims, typeof output.answer === 'string' ? [] : output.answer.comparisons || [])) trace.stage('publication');
    } catch (error) {
      // Never persist raw provider errors, which may include credentials or request content.
      const deadlineExpired = Boolean(deadlineController?.signal.aborted && !signal?.aborted) || (error instanceof Error && error.message === 'Deadline exceeded');
      if (deadlineExpired) {
        const { requested_subjects: subjects } = await store.researchBudget(owner, run);
        const gaps = subjects.length ? ` Supported findings or explicit evidence gaps are still needed for: ${subjects.join(', ')}.` : '';
        if (await store.publishIncomplete(owner, run, `Research reached its time limit before a verified answer was ready. No supported partial findings are available yet.${gaps} Continue research with a fresh time limit, or narrow the question.`)) trace.stage('incomplete');
      } else if (!signal?.aborted) {
        if (error instanceof ContextBudgetError) {
          if (await store.publish(owner, run, 'The requested history and instructions exceed the configured context limit. Narrow the topic or date so I can keep the original evidence and answer safely.')) trace.stage('publication');
        } else if (error instanceof RunBudgetExceeded) {
          const { requested_subjects: subjects } = await store.researchBudget(owner, run);
          const gaps = subjects.length ? ` Supported findings or explicit evidence gaps are still needed for: ${subjects.join(', ')}.` : '';
          if (await store.publishIncomplete(owner, run, `Research reached a shared call, query, or context budget before a verified answer was ready. No supported partial findings are available yet.${gaps} Continue with a fresh budget, or narrow the question.`)) trace.stage('incomplete');
        }
        else { trace.stage('failure'); await store.fail(owner, run, 'The research provider failed before a verified answer was ready. Check gateway and search configuration, then retry.'); }
      }
    } finally { if (deadlineTimer) clearTimeout(deadlineTimer); if (signal?.aborted) trace.stage('cancelled'); trace.finish(); }
  };
}

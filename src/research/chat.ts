import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { ChatOpenAI } from '@langchain/openai';
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Store } from '../persistence/store.js';
import { traceTurn, type TraceSink } from '../telemetry/tracing.js';
import { requiresCurrentVerification } from './freshness.js';

export type ChatMessage = { role: string; content: string };
export type ChatOutput = string | { content: string; claims: { claim: string; evidenceIds: string[] }[] };
export type ChatClient = (messages: ChatMessage[], onChunk: (chunk: string) => void, signal: AbortSignal) => Promise<ChatOutput>;

// Character limit is deliberately conservative until model-specific token counting is introduced.
export const MAX_CONTEXT_CHARS = 16_000;
export const MAX_INPUT_CHARS = 8_000;

export function gatewayClient(baseURL: string, apiKey: string, model: string, verifyCurrent = false): ChatClient {
  const client = new ChatOpenAI({ model, apiKey, configuration: { baseURL, fetch: (input, init) => fetch(input, { ...init, redirect: 'error' }) }, maxTokens: 1024, maxRetries: 0, timeout: 55_000 });
  return async (messages, onChunk, signal) => {
    if (verifyCurrent || requiresCurrentVerification(messages[messages.length - 1]?.content || '')) {
      return 'Web search is not configured, so I cannot verify current information.';
    }
    const stream = await client.stream([new SystemMessage('Web search is unavailable. For questions requiring current or externally verified information, clearly say you cannot verify it rather than presenting an unverified current claim.'), ...messages.map(m => m.role === 'assistant' ? new AIMessage(m.content) : new HumanMessage(m.content))], { signal });
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

async function invokeWithinDeadline(client: ChatClient, messages: ChatMessage[], onChunk: (chunk: string) => void, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      client(messages, chunk => { if (!controller.signal.aborted) onChunk(chunk); }, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new Error('Deadline exceeded')); }, timeoutMs);
      }),
    ]);
  } finally {
    controller.abort();
    if (timer) clearTimeout(timer);
  }
}

const State = Annotation.Root({ messages: Annotation<ChatMessage[]>(), answer: Annotation<ChatOutput>() });

export function createChatRunner(store: Store, checkpointer: SqliteSaver, client: ChatClient, onChunk: (run: string, chunk: string) => void = () => {}, sink?: TraceSink, deadlineMs = 60_000) {
  return async (owner: string, run: string) => {
    const record = await store.getRun(owner, run);
    if (record.status !== 'active') return;
    const trace = traceTurn(run, sink, new Date(record.created_at).getTime());
    try {
      const { current, history: prior } = await store.context(owner, run);
      const selected: ChatMessage[] = [];
      let size = Buffer.byteLength(current.content);
      // Select whole prior user/assistant pairs from newest to oldest.
      for (let i = prior.length - 1; i > 0; i -= 2) {
        const user = prior[i - 1], assistant = prior[i];
        if (user.role !== 'user' || assistant.role !== 'assistant') break;
        if (size + Buffer.byteLength(user.content) + Buffer.byteLength(assistant.content) > MAX_CONTEXT_CHARS) break;
        selected.unshift({ role: user.role, content: user.content }, { role: assistant.role, content: assistant.content });
        size += Buffer.byteLength(user.content) + Buffer.byteLength(assistant.content);
      }
      selected.push({ role: 'user', content: current.content });
      if (size > MAX_CONTEXT_CHARS || current.content.length > MAX_INPUT_CHARS) throw new Error('Input exceeds context limit');
      trace.stage('inference');
      const graph = new StateGraph(State)
        .addNode('chat', async state => ({ answer: await invokeWithinDeadline(client, state.messages, chunk => onChunk(run, chunk), deadlineMs) }))
        .addEdge(START, 'chat').addEdge('chat', END).compile({ checkpointer });
      const output = await graph.invoke({ messages: selected }, { configurable: { thread_id: run } });
      if (await store.publish(owner, run, typeof output.answer === 'string' ? output.answer : output.answer.content, typeof output.answer === 'string' ? [] : output.answer.claims)) trace.stage('publication');
    } catch {
      trace.stage('failure');
      // Never persist raw provider errors, which may include credentials or request content.
      await store.fail(owner, run, 'The chat service failed or timed out. Check gateway configuration and try again.');
    } finally { trace.finish(); }
  };
}

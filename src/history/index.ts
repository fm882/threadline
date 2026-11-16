import { createHash } from 'node:crypto';
import type { Store, EmbeddingSpace, IndexJob, ReferenceCandidate } from '../persistence/store.js';
import type { RetrievalInference } from '../inference/retrieval.js';

export type HistoryRetrievalResult = { candidates: ReferenceCandidate[]; truncated: boolean; coverage: 'complete' | 'incomplete' };
export type HistoryRetriever = (owner: string, runId: string, terms: string[], discussionDate: string | null, query: string) => Promise<HistoryRetrievalResult>;

export function chunkExchange(messageId: string, question: string, answer: string, chunkingVersion: string, maxChars = 1200, overlap = 160) {
  const sourceHash = createHash('sha256').update(`${question}\u001f${answer}`).digest('hex');
  const text = `${question}\n\nAssistant response:\n${answer}`;
  const chunks: { id: string; content: string; contentHash: string; spanStart: number; spanEnd: number }[] = [];
  for (let start = 0; start < text.length; start += maxChars - overlap) {
    const end = Math.min(start + maxChars, text.length);
    const content = text.slice(start, end);
    const spanKey = `${messageId}:${chunkingVersion}:${start}:${end}`;
    chunks.push({ id: createHash('sha256').update(spanKey).digest('hex'), content, contentHash: createHash('sha256').update(content).digest('hex'), spanStart: start, spanEnd: end });
    if (end === text.length) break;
  }
  return { sourceHash, chunks };
}

export async function processIndexJob(store: Store, job: IndexJob, space: EmbeddingSpace, embed: (inputs: string[], mode?: 'query' | 'document') => Promise<number[][]>) {
  const claimed = await store.claimIndexJob(job.id);
  if (!claimed) return false;
  try {
    const source = await store.indexSource(job.owner_id, job.message_id);
    if (!source) { await store.skipIndexJob(claimed, 'Source is no longer eligible'); return false; }
    const { sourceHash, chunks } = chunkExchange(source.id, source.content, source.answer, space.chunkingVersion);
    const vectors = await embed(chunks.map(chunk => chunk.content), 'document');
    return await store.saveIndexBatch(claimed, sourceHash, chunks, vectors, space.chunkingVersion);
  } catch {
    await store.failIndexJob(claimed);
    return false;
  }
}

export function startIndexingWorker(store: Store, space: EmbeddingSpace | null, inference: RetrievalInference | null, intervalMs = 1000, batchSize = 4) {
  if (!space || !inference) return () => {};
  let stopped = false;
  let active: Promise<void> | null = null;
  const work = async () => {
    if (stopped || active) return;
    active = (async () => {
      const jobs = await store.pendingIndexJobs(batchSize, space);
      for (const job of jobs) {
        if (stopped) break;
        await processIndexJob(store, job, space, inference.embed);
      }
    })().catch(() => {}).finally(() => { active = null; });
    await active;
  };
  void work();
  const timer = setInterval(() => { void work(); }, intervalMs);
  return async () => { stopped = true; clearInterval(timer); if (active) await active; };
}

export function createHybridHistoryRetriever(
  store: Store,
  spaceSource: EmbeddingSpace | null | (() => Promise<EmbeddingSpace | null>),
  inferenceSource: RetrievalInference | null | ((space: EmbeddingSpace) => RetrievalInference | null | Promise<RetrievalInference | null>),
): HistoryRetriever {
  return async (owner, runId, terms, discussionDate, query) => {
    const lexical = await store.findReferenceCandidates(owner, runId, terms, discussionDate);
    const space = typeof spaceSource === 'function' ? await spaceSource() : spaceSource;
    const inference = space && typeof inferenceSource === 'function' ? await inferenceSource(space) : inferenceSource as RetrievalInference | null;
    if (!space || !inference) return { ...lexical, coverage: 'incomplete' };
    let vectorCandidates: (ReferenceCandidate & { similarity: number })[] = [];
    let complete = false;
    try {
      const [vector] = await inference.embed([query], 'query');
      const [retrieved, coverage] = await Promise.all([
        store.indexedReferenceCandidates(owner, runId, terms, discussionDate, vector, space),
        store.embeddingCoverage(owner, runId, space),
      ]);
      vectorCandidates = retrieved.candidates;
      complete = coverage.complete && !retrieved.truncated;
    } catch {
      return { ...lexical, coverage: 'incomplete' };
    }
    const fused = new Map<string, { candidate: ReferenceCandidate; score: number }>();
    lexical.candidates.slice(0, 40).forEach((candidate, rank) => fused.set(candidate.id, { candidate, score: 1 / (60 + rank + 1) }));
    vectorCandidates.slice(0, 40).forEach((candidate, rank) => {
      const entry = fused.get(candidate.id) || { candidate, score: 0 };
      entry.score += 1 / (60 + rank + 1);
      fused.set(candidate.id, entry);
    });
    let ranked = [...fused.values()].sort((left, right) => right.score - left.score || right.candidate.created_at.getTime() - left.candidate.created_at.getTime())
      .slice(0, 40).map(entry => ({ ...entry.candidate, score: Math.round(entry.score * 10_000) }));
    if (inference.rerank && ranked.length > 1) {
      try {
        const order = await inference.rerank(query, ranked.map(candidate => `${candidate.content}\n${candidate.answer}`));
        ranked = order.map((index, rank) => ({ ...ranked[index], score: (ranked.length - rank) * 1000 }));
      } catch { /* Keep reciprocal-rank fusion when reranking is unavailable. */ }
    }
    return { candidates: ranked, truncated: lexical.truncated, coverage: complete ? 'complete' : 'incomplete' };
  };
}

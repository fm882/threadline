export type RetrievalInference = {
  embed: (inputs: string[], mode?: 'query' | 'document') => Promise<number[][]>;
  rerank: (query: string, documents: string[]) => Promise<number[]>;
};

export type EmbeddingConfig = {
  base: string;
  key: string;
  model: string;
  dimensions: number;
  normalized: boolean;
  queryMode: string;
  documentMode: string;
};

export type RerankConfig = { url: string; key: string; model: string };

function validateVector(value: unknown, dimensions: number, normalized: boolean) {
  if (!Array.isArray(value) || value.length !== dimensions || !value.every(item => typeof item === 'number' && Number.isFinite(item))) throw new Error('Embedding returned an invalid vector shape.');
  const norm = Math.sqrt(value.reduce((sum, item) => sum + item * item, 0));
  if (!Number.isFinite(norm) || norm === 0) throw new Error('Embedding returned a zero or invalid vector.');
  if (normalized && (norm < 0.99 || norm > 1.01)) throw new Error('Embedding did not match the configured normalized vector space.');
  return value as number[];
}

export function createEmbeddingClient(config: EmbeddingConfig, request: typeof fetch = fetch) {
  if (!/^[a-zA-Z0-9._-]{1,64}$/.test(config.queryMode) || !/^[a-zA-Z0-9._-]{1,64}$/.test(config.documentMode)) throw new Error('Embedding input modes must be configured identifiers.');
  return async (inputs: string[], mode: 'query' | 'document' = 'document') => {
    if (!inputs.length || inputs.some(input => !input.trim())) throw new Error('Embedding input must contain nonempty text.');
    const response = await request(`${config.base.replace(/\/$/, '')}/embeddings`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, dimensions: config.dimensions, encoding_format: 'float', input: inputs, ...((mode === 'query' ? config.queryMode : config.documentMode) === 'shared' ? {} : { input_type: mode === 'query' ? config.queryMode : config.documentMode }) }),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Embedding gateway request failed with HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data) || data.data.length !== inputs.length) throw new Error('Embedding gateway returned an invalid response.');
    const rows = data.data as { index?: unknown; embedding?: unknown }[];
    const ordered = [...rows].sort((a, b) => Number(a.index) - Number(b.index));
    if (ordered.some((row, index) => row.index !== index)) throw new Error('Embedding gateway returned invalid input indexes.');
    return ordered.map(row => validateVector(row.embedding, config.dimensions, config.normalized));
  };
}

export function createRerankClient(config: RerankConfig, request: typeof fetch = fetch) {
  return async (query: string, documents: string[]) => {
    if (!query.trim() || !documents.length || documents.some(document => !document.trim())) throw new Error('Rerank input must include a query and nonempty documents.');
    const response = await request(config.url, {
      method: 'POST', headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, query, documents, top_n: documents.length }),
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Rerank gateway request failed with HTTP ${response.status}.`);
    const data: unknown = await response.json();
    if (!data || typeof data !== 'object' || !('results' in data) || !Array.isArray(data.results)) throw new Error('Rerank gateway returned an invalid response.');
    const rows = data.results as { index?: unknown; relevance_score?: unknown }[];
    if (rows.length !== documents.length) throw new Error('Rerank gateway returned incomplete rankings.');
    const seen = new Set<number>();
    for (const row of rows) {
      if (!Number.isInteger(row.index) || Number(row.index) < 0 || Number(row.index) >= documents.length || seen.has(Number(row.index)) || typeof row.relevance_score !== 'number' || !Number.isFinite(row.relevance_score)) throw new Error('Rerank gateway returned invalid rankings.');
      seen.add(Number(row.index));
    }
    return [...rows].sort((a, b) => Number(b.relevance_score) - Number(a.relevance_score)).map(row => Number(row.index));
  };
}

export function vectorSpaceConfig(env: NodeJS.ProcessEnv) {
  const model = env.EMBEDDING_MODEL || 'history-embedding-v1';
  const dimensions = Number(env.EMBEDDING_DIMENSIONS || 1024);
  const id = env.EMBEDDING_SPACE_ID || `titan-v2-${dimensions}-v1`;
  const queryMode = env.EMBEDDING_QUERY_INPUT_MODE || 'shared', documentMode = env.EMBEDDING_DOCUMENT_INPUT_MODE || 'shared';
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8192 || !/^[a-zA-Z0-9._-]{1,120}$/.test(id) || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(model) || !/^[a-zA-Z0-9._-]{1,64}$/.test(queryMode) || !/^[a-zA-Z0-9._-]{1,64}$/.test(documentMode)) throw new Error('Configure a valid immutable embedding space ID, model, dimension, and input modes.');
  return { id, model, dimensions, normalized: env.EMBEDDING_NORMALIZED !== 'false', queryMode, documentMode, chunkingVersion: env.HISTORY_CHUNKING_VERSION || 'exchange-v1' };
}

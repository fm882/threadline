import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import type { SearchResult } from '../search/tavily.js';
import { interpretDateReference } from '../history/date-reference.js';

export type EmbeddingSpace = { id: string; generation: number; model: string; dimensions: number; normalized: boolean; queryMode: string; documentMode: string; chunkingVersion: string; status: string };
export type IndexJob = { id: string; message_id: string; owner_id: string; space_id: string; generation: number; attempts: number };
export type VectorReferenceCandidate = ReferenceCandidate & { similarity: number };

export class Conflict extends Error {}
export class NotFound extends Error {}

const payloadHash = (input: string, verifyCurrent = false, continuationOf: string | null = null) => createHash('sha256').update(JSON.stringify(continuationOf ? { input, verifyCurrent, continuationOf } : verifyCurrent ? { input, verifyCurrent } : { input })).digest('hex');

type Run = { id: string; conversation_id: string; status: string; cutoff: number; error: string | null; created_at: Date; verify_current: boolean; timezone: string; parent_run_id: string | null };
type Message = { id: string; role: string; content: string; ordinal: number; created_at: Date; run_id?: string | null; run_status?: string | null; citation_ids?: string[]; recall_snapshot_id?: string | null; reference_snapshot_id?: string | null; reference_coverage?: 'complete' | 'incomplete' | null };
export type ReferenceCandidate = { id: string; conversation_id: string; conversation_title: string; content: string; answer: string; answer_id: string | null; answer_ordinal: number | null; answer_created_at: Date | null; ordinal: number; created_at: Date; score: number };
export type HistoricalClaimEvidence = { claim: string; evidence: { id: string; title: string; url: string; excerpt: string; observed_at: Date }[] };
export type HistoricalCorrection = { id: string; correction: string; created_at: Date };
export type ReferenceSnapshotItem = Omit<ReferenceCandidate, 'score'> & { rank: number; historical_claims: HistoricalClaimEvidence[]; corrections: HistoricalCorrection[] };
export type ComparisonClaim = { subject: string; attribute: string; outcome: 'supported_change' | 'prior_error' | 'no_relevant_update_found' | 'inconclusive' | 'historical_support_missing'; statement: string; evidenceIds: string[]; baselineOrigin: 'stored_evidence' | 'reconstructed' | 'user_reported' | 'mixed' | 'unsupported'; baselineStatement?: string; baselinePeriod?: string; userQuote?: string; historicalEvidenceIds: string[]; baselineConflict?: boolean; priorDimensions?: Record<string, string | number>; currentDimensions?: Record<string, string | number> };
export type ReferenceSnapshot = { id: string; run_id: string; status: string; coverage: string; discussion_date: string | null; comparison_date: string | null; items: ReferenceSnapshotItem[] };

export class Store {
  constructor(readonly db: PGlite) {}

  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS title TEXT NOT NULL DEFAULT 'Conversation';
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS timezone_source TEXT NOT NULL DEFAULT 'unset';
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS recall_eligible BOOLEAN NOT NULL DEFAULT true;
      ALTER TABLE conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      CREATE TABLE IF NOT EXISTS conversation_cleanup (conversation_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, queued_at TIMESTAMPTZ NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL,
        input TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(conversation_id, idempotency_key)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn ON turns(conversation_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS owner_sequences (owner_id TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
        owner_id TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id), role TEXT NOT NULL,
        content TEXT NOT NULL, ordinal INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(owner_id, ordinal), UNIQUE(turn_id, role)
      );
      CREATE TABLE IF NOT EXISTS history_chunks (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL REFERENCES messages(id),
        answer_id TEXT REFERENCES messages(id), source_hash TEXT NOT NULL, content_hash TEXT NOT NULL, content TEXT NOT NULL,
        chunking_version TEXT NOT NULL, span_start INTEGER NOT NULL, span_end INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(message_id, chunking_version, span_start, span_end)
      );
      ALTER TABLE history_chunks ADD COLUMN IF NOT EXISTS chunking_version TEXT NOT NULL DEFAULT 'exchange-v1';
      ALTER TABLE history_chunks DROP CONSTRAINT IF EXISTS history_chunks_message_id_span_start_span_end_key;
      CREATE UNIQUE INDEX IF NOT EXISTS history_chunk_source_span ON history_chunks(message_id, chunking_version, span_start, span_end);
      CREATE TABLE IF NOT EXISTS embedding_spaces (
        id TEXT NOT NULL, generation INTEGER NOT NULL, model TEXT NOT NULL, dimensions INTEGER NOT NULL, normalized BOOLEAN NOT NULL,
        query_mode TEXT NOT NULL, document_mode TEXT NOT NULL, chunking_version TEXT NOT NULL, status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(id, generation)
      );
      DROP INDEX IF EXISTS one_active_embedding_generation;
      CREATE UNIQUE INDEX one_active_embedding_generation ON embedding_spaces(status) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS chunk_embeddings (
        chunk_id TEXT NOT NULL REFERENCES history_chunks(id), space_id TEXT NOT NULL, generation INTEGER NOT NULL,
        owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_hash TEXT NOT NULL, dimensions INTEGER NOT NULL,
        vector JSONB NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY(chunk_id, space_id, generation), FOREIGN KEY(space_id, generation) REFERENCES embedding_spaces(id, generation)
      );
      CREATE TABLE IF NOT EXISTS indexing_jobs (
        id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id), owner_id TEXT NOT NULL,
        space_id TEXT NOT NULL, generation INTEGER NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(message_id, space_id, generation), FOREIGN KEY(space_id, generation) REFERENCES embedding_spaces(id, generation)
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id), owner_id TEXT NOT NULL,
        status TEXT NOT NULL, cutoff INTEGER NOT NULL, error TEXT, parent_run_id TEXT REFERENCES runs(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS parent_run_id TEXT REFERENCES runs(id);
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS verify_current BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';
      CREATE TABLE IF NOT EXISTS jobs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), status TEXT NOT NULL
      );
      ALTER TABLE jobs ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS search_queries (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL,
        query TEXT NOT NULL, status TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS evidence_observations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL,
        url TEXT NOT NULL, title TEXT NOT NULL, excerpt TEXT NOT NULL, excerpt_hash TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL, provider TEXT NOT NULL, representation TEXT NOT NULL
      );
      ALTER TABLE evidence_observations ADD COLUMN IF NOT EXISTS search_query_id TEXT REFERENCES search_queries(id);
      CREATE TABLE IF NOT EXISTS history_snapshots (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), owner_id TEXT NOT NULL,
        local_date DATE NOT NULL, timezone TEXT NOT NULL, cutoff INTEGER NOT NULL,
        status TEXT NOT NULL, total INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE history_snapshots ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS history_snapshot_items (
        snapshot_id TEXT NOT NULL REFERENCES history_snapshots(id), message_id TEXT NOT NULL REFERENCES messages(id),
        content_hash TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, recorded_ordinal INTEGER NOT NULL,
        conversation_id TEXT NOT NULL, PRIMARY KEY(snapshot_id, message_id)
      );
      ALTER TABLE history_snapshot_items ADD COLUMN IF NOT EXISTS recorded_at TIMESTAMPTZ;
      ALTER TABLE history_snapshot_items ADD COLUMN IF NOT EXISTS recorded_ordinal INTEGER;
      ALTER TABLE history_snapshot_items ADD COLUMN IF NOT EXISTS conversation_id TEXT;
      ALTER TABLE history_snapshot_items ADD COLUMN IF NOT EXISTS source_timezone TEXT;
      CREATE TABLE IF NOT EXISTS reference_snapshots (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE REFERENCES runs(id), owner_id TEXT NOT NULL,
        status TEXT NOT NULL, coverage TEXT NOT NULL, discussion_date DATE, comparison_date DATE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE reference_snapshots ADD COLUMN IF NOT EXISTS revoked BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS reference_snapshot_items (
        snapshot_id TEXT NOT NULL REFERENCES reference_snapshots(id), message_id TEXT NOT NULL REFERENCES messages(id),
        content_hash TEXT NOT NULL, recorded_at TIMESTAMPTZ NOT NULL, recorded_ordinal INTEGER NOT NULL,
        conversation_id TEXT NOT NULL, rank INTEGER NOT NULL, answer_id TEXT REFERENCES messages(id), answer_hash TEXT,
        answer_recorded_at TIMESTAMPTZ, answer_recorded_ordinal INTEGER, PRIMARY KEY(snapshot_id, message_id)
      );
      ALTER TABLE reference_snapshot_items ADD COLUMN IF NOT EXISTS answer_id TEXT REFERENCES messages(id);
      ALTER TABLE reference_snapshot_items ADD COLUMN IF NOT EXISTS answer_hash TEXT;
      ALTER TABLE reference_snapshot_items ADD COLUMN IF NOT EXISTS answer_recorded_at TIMESTAMPTZ;
      ALTER TABLE reference_snapshot_items ADD COLUMN IF NOT EXISTS answer_recorded_ordinal INTEGER;
      CREATE TABLE IF NOT EXISTS reference_snapshot_claims (
        snapshot_id TEXT NOT NULL REFERENCES reference_snapshots(id), message_id TEXT NOT NULL REFERENCES messages(id),
        source_claim_id TEXT NOT NULL, claim TEXT NOT NULL, claim_hash TEXT NOT NULL,
        PRIMARY KEY(snapshot_id, source_claim_id)
      );
      CREATE TABLE IF NOT EXISTS reference_snapshot_evidence (
        snapshot_id TEXT NOT NULL REFERENCES reference_snapshots(id), source_claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT NOT NULL, excerpt TEXT NOT NULL, excerpt_hash TEXT NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(snapshot_id, source_claim_id, evidence_id),
        FOREIGN KEY(snapshot_id, source_claim_id) REFERENCES reference_snapshot_claims(snapshot_id, source_claim_id)
      );
      CREATE TABLE IF NOT EXISTS answer_claims (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL, claim TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_evidence (
        claim_id TEXT NOT NULL REFERENCES answer_claims(id), evidence_id TEXT NOT NULL REFERENCES evidence_observations(id),
        PRIMARY KEY (claim_id, evidence_id)
      );
      CREATE TABLE IF NOT EXISTS answer_comparisons (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL, subject TEXT NOT NULL,
        attribute TEXT NOT NULL, outcome TEXT NOT NULL, statement TEXT NOT NULL, evidence_ids JSONB NOT NULL,
        prior_dimensions JSONB, current_dimensions JSONB, baseline_origin TEXT NOT NULL DEFAULT 'unsupported',
        baseline_statement TEXT, baseline_period TEXT, user_quote TEXT, historical_evidence_ids JSONB NOT NULL DEFAULT '[]', baseline_conflict BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS baseline_origin TEXT NOT NULL DEFAULT 'unsupported';
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS baseline_statement TEXT;
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS baseline_period TEXT;
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS user_quote TEXT;
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS historical_evidence_ids JSONB NOT NULL DEFAULT '[]';
      ALTER TABLE answer_comparisons ADD COLUMN IF NOT EXISTS baseline_conflict BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id),
        comparison_run_id TEXT NOT NULL REFERENCES runs(id), correction TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id SERIAL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async beginAttempt(owner: string, runId: string, maximum = 2) {
    const result = await this.db.query(`UPDATE jobs SET attempts = attempts + 1
      WHERE run_id = $1 AND status = 'pending' AND attempts < $3
      AND EXISTS (SELECT 1 FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND r.status = 'active' AND c.deleted_at IS NULL) RETURNING attempts`, [runId, owner, maximum]);
    return result.rows.length > 0;
  }

  async pendingRuns(limit = 100) {
    return (await this.db.query<{ id: string; owner_id: string }>(`SELECT r.id, r.owner_id FROM runs r JOIN jobs j ON j.run_id = r.id
      JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id
      WHERE r.status = 'active' AND j.status = 'pending' AND c.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM reference_snapshot_items i JOIN reference_snapshots rs ON rs.id = i.snapshot_id JOIN conversations source_c ON source_c.id = i.conversation_id WHERE rs.run_id = r.id AND (source_c.deleted_at IS NOT NULL OR (source_c.id <> r.conversation_id AND source_c.recall_eligible = false)))
        AND NOT EXISTS (SELECT 1 FROM history_snapshot_items i JOIN history_snapshots hs ON hs.id = i.snapshot_id JOIN conversations source_c ON source_c.id = i.conversation_id WHERE hs.run_id = r.id AND (source_c.deleted_at IS NOT NULL OR (source_c.id <> r.conversation_id AND source_c.recall_eligible = false)))
      ORDER BY r.created_at, r.id LIMIT $1`, [limit])).rows;
  }

  async createConversation(owner: string) {
    const id = randomUUID();
    await this.db.query('INSERT INTO conversations (id, owner_id) VALUES ($1, $2)', [id, owner]);
    return id;
  }

  async createEmbeddingGeneration(config: Omit<EmbeddingSpace, 'generation' | 'status'>, staged = false): Promise<EmbeddingSpace> {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(config.id) || !/^[a-zA-Z0-9._:/-]{1,120}$/.test(config.model) || !Number.isInteger(config.dimensions) || config.dimensions < 1 || !/^[a-zA-Z0-9._-]{1,64}$/.test(config.queryMode) || !/^[a-zA-Z0-9._-]{1,64}$/.test(config.documentMode) || !/^[a-zA-Z0-9._-]{1,120}$/.test(config.chunkingVersion)) throw new Error('Invalid embedding-space configuration');
    return this.db.transaction(async tx => {
      const rows = await tx.query<EmbeddingSpace>(`SELECT id, generation, model, dimensions, normalized, query_mode AS "queryMode", document_mode AS "documentMode", chunking_version AS "chunkingVersion", status
        FROM embedding_spaces WHERE id = $1 ORDER BY generation DESC LIMIT 1`, [config.id]);
      const latest = rows.rows[0];
      if (latest && (latest.model !== config.model || latest.dimensions !== config.dimensions || latest.normalized !== config.normalized || latest.queryMode !== config.queryMode || latest.documentMode !== config.documentMode || latest.chunkingVersion !== config.chunkingVersion)) throw new Conflict('Embedding-space identities are immutable; use a new ID for changed configuration');
      if (latest && !staged) return latest;
      const max = await tx.query<{ generation: number }>('SELECT COALESCE(MAX(generation), 0)::int AS generation FROM embedding_spaces WHERE id = $1', [config.id]);
      const generation = max.rows[0].generation + 1;
      const active = await tx.query("SELECT 1 FROM embedding_spaces WHERE status = 'active' LIMIT 1");
      const status = staged || active.rows.length ? 'building' : 'active';
      await tx.query(`INSERT INTO embedding_spaces (id, generation, model, dimensions, normalized, query_mode, document_mode, chunking_version, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [config.id, generation, config.model, config.dimensions, config.normalized, config.queryMode, config.documentMode, config.chunkingVersion, status]);
      await tx.query(`INSERT INTO indexing_jobs (id, message_id, owner_id, space_id, generation, status)
        SELECT md5(m.id || $1 || $2::int::text), m.id, m.owner_id, $1, $2::int, 'pending' FROM messages m JOIN turns t ON t.id = m.turn_id
        JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
        WHERE m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true
        ON CONFLICT (message_id, space_id, generation) DO NOTHING`, [config.id, generation]);
      return { ...config, generation, status };
    });
  }

  async activeEmbeddingGeneration(): Promise<EmbeddingSpace | null> {
    return (await this.db.query<EmbeddingSpace>(`SELECT id, generation, model, dimensions, normalized, query_mode AS "queryMode", document_mode AS "documentMode", chunking_version AS "chunkingVersion", status
      FROM embedding_spaces WHERE status = 'active' LIMIT 1`)).rows[0] ?? null;
  }

  async listEmbeddingGenerations() {
    return (await this.db.query<{ id: string; status: string }>(`SELECT es.id, es.generation, es.model, es.dimensions, es.normalized, es.query_mode, es.document_mode, es.chunking_version, es.status, es.created_at,
      (SELECT count(*)::int FROM messages m JOIN turns t ON t.id = m.turn_id JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true) AS eligible_exchanges,
      (SELECT count(*)::int FROM indexing_jobs j WHERE j.space_id = es.id AND j.generation = es.generation AND j.status = 'completed') AS indexed_exchanges,
      (SELECT count(*)::int FROM indexing_jobs j WHERE j.space_id = es.id AND j.generation = es.generation AND j.status IN ('pending', 'failed', 'processing')) AS pending_exchanges
      FROM embedding_spaces es ORDER BY es.created_at DESC, es.id, es.generation DESC`)).rows;
  }

  async activateEmbeddingGeneration(spaceId: string, generation: number) {
    return this.db.transaction(async tx => {
      const target = await tx.query<{ chunking_version: string }>('SELECT chunking_version FROM embedding_spaces WHERE id = $1 AND generation = $2 AND status IN (\'building\', \'active\', \'retired\')', [spaceId, generation]);
      if (!target.rows.length) throw new NotFound('Embedding generation not found');
      const pending = await tx.query<{ count: number }>(`SELECT count(*)::int AS count FROM messages m JOIN turns t ON t.id = m.turn_id JOIN conversations c ON c.id = m.conversation_id
        WHERE m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true
          AND (NOT EXISTS (SELECT 1 FROM indexing_jobs j WHERE j.message_id = m.id AND j.space_id = $1 AND j.generation = $2 AND j.status = 'completed'
            AND j.source_hash = encode(sha256(convert_to(m.content || chr(31) || COALESCE((SELECT a.content FROM messages a WHERE a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'), ''), 'UTF8')), 'hex'))
            OR EXISTS (SELECT 1 FROM history_chunks h WHERE h.message_id = m.id AND h.chunking_version = $3 AND NOT EXISTS (SELECT 1 FROM chunk_embeddings ce WHERE ce.chunk_id = h.id AND ce.space_id = $1 AND ce.generation = $2 AND ce.status = 'ready')))` , [spaceId, generation, target.rows[0].chunking_version]);
      if (pending.rows[0].count > 0) throw new Conflict('Embedding generation must finish indexing eligible originals before activation');
      await tx.query("UPDATE embedding_spaces SET status = 'retired' WHERE status = 'active'");
      await tx.query("UPDATE embedding_spaces SET status = 'active' WHERE id = $1 AND generation = $2", [spaceId, generation]);
    });
  }

  async pendingIndexJobs(limit = 20, space?: Pick<EmbeddingSpace, 'id' | 'generation'>): Promise<IndexJob[]> {
    return (await this.db.query<IndexJob>(`SELECT j.id, j.message_id, j.owner_id, j.space_id, j.generation, j.attempts FROM indexing_jobs j
      JOIN messages m ON m.id = j.message_id AND m.owner_id = j.owner_id JOIN turns t ON t.id = m.turn_id
      JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id JOIN embedding_spaces es ON es.id = j.space_id AND es.generation = j.generation
      WHERE (j.status IN ('pending', 'failed') OR (j.status = 'processing' AND j.updated_at < now() - interval '5 minutes'))
        AND j.attempts < 3 AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true AND es.status IN ('active', 'building')
        AND ($2::text IS NULL OR (j.space_id = $2 AND j.generation = $3))
      ORDER BY j.created_at, j.id LIMIT $1`, [limit, space?.id ?? null, space?.generation ?? null])).rows;
  }

  async claimIndexJob(jobId: string) {
    const result = await this.db.query<IndexJob>(`UPDATE indexing_jobs j SET status = 'processing', attempts = attempts + 1, updated_at = now()
      WHERE j.id = $1 AND j.attempts < 3 AND (j.status IN ('pending', 'failed') OR (j.status = 'processing' AND j.updated_at < now() - interval '5 minutes'))
        AND EXISTS (SELECT 1 FROM messages m JOIN turns t ON t.id = m.turn_id JOIN conversations c ON c.id = m.conversation_id WHERE m.id = j.message_id AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true)
      RETURNING id, message_id, owner_id, space_id, generation, attempts`, [jobId]);
    return result.rows[0] ?? null;
  }

  async indexSource(owner: string, messageId: string) {
    const result = await this.db.query<{ id: string; content: string; created_at: Date; answer_id: string | null; answer: string; answer_created_at: Date | null }>(`SELECT m.id, m.content, m.created_at, a.id AS answer_id, COALESCE(a.content, '') AS answer, a.created_at AS answer_created_at
      FROM messages m JOIN turns t ON t.id = m.turn_id AND t.owner_id = m.owner_id JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
      LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
      WHERE m.id = $1 AND m.owner_id = $2 AND m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true`, [messageId, owner]);
    return result.rows[0] ?? null;
  }

  async saveIndexBatch(job: IndexJob, sourceHash: string, chunks: { id: string; content: string; contentHash: string; spanStart: number; spanEnd: number }[], vectors: number[][], chunkingVersion: string) {
    if (!chunks.length || chunks.length !== vectors.length) throw new Error('Index batch shape mismatch');
    return this.db.transaction(async tx => {
      const source = await tx.query<{ question: string; answer: string; answer_id: string | null; source_hash: string; eligible: boolean }>(`SELECT m.content AS question, COALESCE(a.content, '') AS answer, a.id AS answer_id,
        encode(sha256(convert_to(m.content || chr(31) || COALESCE(a.content, ''), 'UTF8')), 'hex') AS source_hash,
        (c.deleted_at IS NULL AND c.recall_eligible = true AND t.status = 'completed') AS eligible
        FROM indexing_jobs j JOIN messages m ON m.id = j.message_id AND m.owner_id = j.owner_id JOIN turns t ON t.id = m.turn_id
        JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
        WHERE j.id = $1 AND j.owner_id = $2 AND j.status = 'processing'`, [job.id, job.owner_id]);
      const record = source.rows[0];
      if (!record || !record.eligible || record.source_hash !== sourceHash) {
        await tx.query("UPDATE indexing_jobs SET status = 'skipped', error = 'Source changed or recall became ineligible', updated_at = now() WHERE id = $1", [job.id]);
        return false;
      }
      const space = await tx.query<{ dimensions: number; status: string; normalized: boolean }>('SELECT dimensions, status, normalized FROM embedding_spaces WHERE id = $1 AND generation = $2', [job.space_id, job.generation]);
      if (!space.rows.length || !['active', 'building'].includes(space.rows[0].status) || vectors.some(vector => {
        if (vector.length !== space.rows[0].dimensions || vector.some(value => !Number.isFinite(value))) return true;
        const norm = Math.hypot(...vector);
        return !norm || (space.rows[0].normalized && (norm < 0.99 || norm > 1.01));
      })) throw new Conflict('Index vectors do not match the selected embedding generation');
      await tx.query(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM history_chunks WHERE message_id = $1 AND chunking_version = $2) AND space_id = $3 AND generation = $4`, [job.message_id, chunkingVersion, job.space_id, job.generation]);
      for (const [index, chunk] of chunks.entries()) {
        await tx.query(`INSERT INTO history_chunks (id, owner_id, conversation_id, message_id, answer_id, source_hash, content_hash, content, chunking_version, span_start, span_end)
          SELECT $1, m.owner_id, m.conversation_id, m.id, $4, $5, $6, $7, $8, $9, $10 FROM messages m WHERE m.id = $2 AND m.owner_id = $3
          ON CONFLICT (message_id, chunking_version, span_start, span_end) DO UPDATE SET source_hash = EXCLUDED.source_hash, content_hash = EXCLUDED.content_hash, content = EXCLUDED.content, answer_id = EXCLUDED.answer_id`, [chunk.id, job.message_id, job.owner_id, record.answer_id, sourceHash, chunk.contentHash, chunk.content, chunkingVersion, chunk.spanStart, chunk.spanEnd]);
        await tx.query(`INSERT INTO chunk_embeddings (chunk_id, space_id, generation, owner_id, conversation_id, source_hash, dimensions, vector, status)
          SELECT $1, $2, $3, m.owner_id, m.conversation_id, $4, $5, $6::jsonb, 'ready' FROM messages m WHERE m.id = $7 AND m.owner_id = $8
          ON CONFLICT (chunk_id, space_id, generation) DO UPDATE SET source_hash = EXCLUDED.source_hash, dimensions = EXCLUDED.dimensions, vector = EXCLUDED.vector, status = 'ready', created_at = now()`, [chunk.id, job.space_id, job.generation, sourceHash, space.rows[0].dimensions, JSON.stringify(vectors[index]), job.message_id, job.owner_id]);
      }
      await tx.query("UPDATE indexing_jobs SET status = 'completed', source_hash = $2, error = NULL, updated_at = now() WHERE id = $1", [job.id, sourceHash]);
      return true;
    });
  }

  async failIndexJob(job: IndexJob, message = 'Embedding provider unavailable') {
    await this.db.query("UPDATE indexing_jobs SET status = 'failed', error = $2, updated_at = now() WHERE id = $1 AND owner_id = $3 AND status = 'processing'", [job.id, message.slice(0, 200), job.owner_id]);
  }

  async skipIndexJob(job: IndexJob, message: string) {
    await this.db.query("UPDATE indexing_jobs SET status = 'skipped', error = $2, source_hash = NULL, updated_at = now() WHERE id = $1 AND owner_id = $3", [job.id, message.slice(0, 200), job.owner_id]);
  }

  async setTimezone(owner: string, conversation: string, timezone: string, source: 'browser' | 'fallback' | 'user', initialize: boolean) {
    const result = await this.db.query<{ timezone: string; timezone_source: string; recall_eligible: boolean }>(`UPDATE conversations SET
      timezone = CASE WHEN $5 AND timezone_source <> 'unset' THEN timezone ELSE $3 END,
      timezone_source = CASE WHEN $5 AND timezone_source <> 'unset' THEN timezone_source ELSE $4 END
      WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING timezone, timezone_source, recall_eligible`, [conversation, owner, timezone, source, initialize]);
    if (!result.rows.length) throw new NotFound('Conversation not found');
    return result.rows[0];
  }

  async listConversations(owner: string, limit = 50, offset = 0) {
    return (await this.db.query('SELECT id, title, created_at, timezone, timezone_source, recall_eligible FROM conversations WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [owner, limit, offset])).rows;
  }

  async pruneOperationalEvents(retentionDays: number, now = new Date()) {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || !Number.isFinite(now.getTime())) throw new Error('Invalid operational event retention policy');
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    const result = await this.db.query(`DELETE FROM run_events WHERE kind = 'progress' AND created_at < $1 RETURNING id`, [cutoff]);
    return result.rows.length;
  }

  private async hasRevokedContext(owner: string, runId: string) {
    const result = await this.db.query(`SELECT 1 FROM reference_snapshots rs JOIN runs current_run ON current_run.id = rs.run_id
      WHERE rs.run_id = $1 AND rs.owner_id = $2 AND rs.revoked = true
      UNION ALL SELECT 1 FROM history_snapshots hs WHERE hs.run_id = $1 AND hs.owner_id = $2 AND hs.revoked = true
      UNION ALL SELECT 1 FROM reference_snapshot_items i JOIN reference_snapshots rs ON rs.id = i.snapshot_id
        JOIN runs current_run ON current_run.id = rs.run_id JOIN conversations source_c ON source_c.id = i.conversation_id
        WHERE rs.run_id = $1 AND rs.owner_id = $2 AND (source_c.deleted_at IS NOT NULL OR (source_c.id <> current_run.conversation_id AND source_c.recall_eligible = false))
      UNION ALL SELECT 1 FROM history_snapshot_items i JOIN history_snapshots hs ON hs.id = i.snapshot_id
        JOIN runs current_run ON current_run.id = hs.run_id JOIN conversations source_c ON source_c.id = i.conversation_id
        WHERE hs.run_id = $1 AND hs.owner_id = $2 AND (source_c.deleted_at IS NOT NULL OR (source_c.id <> current_run.conversation_id AND source_c.recall_eligible = false)) LIMIT 1`, [runId, owner]);
    return result.rows.length > 0;
  }

  async setRecallEligibility(owner: string, conversation: string, eligible: boolean) {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ recall_eligible: boolean }>('UPDATE conversations SET recall_eligible = $3 WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING id, recall_eligible', [conversation, owner, eligible]);
      if (!result.rows.length) throw new NotFound('Conversation not found');
      if (!eligible) {
        await tx.query('DELETE FROM chunk_embeddings WHERE conversation_id = $1 AND owner_id = $2', [conversation, owner]);
        await tx.query('DELETE FROM history_chunks WHERE conversation_id = $1 AND owner_id = $2', [conversation, owner]);
        await tx.query("UPDATE indexing_jobs SET status = 'skipped', source_hash = NULL, error = 'Recall excluded', updated_at = now() WHERE owner_id = $1 AND message_id IN (SELECT id FROM messages WHERE conversation_id = $2)", [owner, conversation]);
      } else {
        await tx.query(`INSERT INTO indexing_jobs (id, message_id, owner_id, space_id, generation, status)
          SELECT md5(m.id || es.id || es.generation::text), m.id, m.owner_id, es.id, es.generation, 'pending' FROM messages m JOIN turns t ON t.id = m.turn_id
          JOIN embedding_spaces es ON es.status IN ('active', 'building') JOIN conversations c ON c.id = m.conversation_id
          WHERE m.conversation_id = $1 AND m.owner_id = $2 AND m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL AND c.recall_eligible = true
          ON CONFLICT (message_id, space_id, generation) DO UPDATE SET status = 'pending', source_hash = NULL, error = NULL, updated_at = now()`, [conversation, owner]);
      }
      return { recall_eligible: result.rows[0].recall_eligible };
    });
  }

  async deleteConversation(owner: string, conversation: string) {
    return this.db.transaction(async tx => {
      const result = await tx.query(`UPDATE conversations SET deleted_at = now() WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL RETURNING id`, [conversation, owner]);
      if (!result.rows.length) throw new NotFound('Conversation not found');
      await tx.query('INSERT INTO conversation_cleanup (conversation_id, owner_id) VALUES ($1, $2) ON CONFLICT (conversation_id) DO NOTHING', [conversation, owner]);
      return (await tx.query<{ id: string }>(`SELECT DISTINCT r.id FROM runs r WHERE r.owner_id = $2 AND r.status = 'active'
        AND (r.conversation_id = $1 OR r.id IN (
          SELECT rs.run_id FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id WHERE i.conversation_id = $1
          UNION SELECT hs.run_id FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id WHERE i.conversation_id = $1
        ))`, [conversation, owner])).rows.map(row => row.id);
    });
  }

  async cleanupDeletedConversations(limit = 20, clearCheckpoints: (runIds: string[]) => Promise<void> = async () => {}) {
    const queued = await this.db.query<{ conversation_id: string; owner_id: string }>('SELECT conversation_id, owner_id FROM conversation_cleanup ORDER BY queued_at LIMIT $1', [limit]);
    for (const { conversation_id: conversation, owner_id: owner } of queued.rows) {
      const runs = await this.db.query<{ id: string }>(`SELECT id FROM runs WHERE conversation_id = $1
        UNION SELECT rs.run_id FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id WHERE i.conversation_id = $1
        UNION SELECT hs.run_id FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id WHERE i.conversation_id = $1`, [conversation]);
      await clearCheckpoints(runs.rows.map(row => row.id));
      await this.db.transaction(async tx => {
      const exists = await tx.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL', [conversation, owner]);
      if (!exists.rows.length) { await tx.query('DELETE FROM conversation_cleanup WHERE conversation_id = $1', [conversation]); return; }
      const dependent = await tx.query<{ id: string }>(`SELECT rs.run_id AS id FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id WHERE i.conversation_id = $1 AND rs.run_id NOT IN (SELECT id FROM runs WHERE conversation_id = $1)
        UNION SELECT hs.run_id AS id FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id WHERE i.conversation_id = $1 AND hs.run_id NOT IN (SELECT id FROM runs WHERE conversation_id = $1)`, [conversation]);
      const dependentIds = dependent.rows.map(row => row.id);
      await tx.query(`DELETE FROM reference_snapshot_evidence WHERE snapshot_id IN (SELECT id FROM reference_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)) OR source_claim_id IN (SELECT ac.id FROM answer_claims ac JOIN runs r ON r.id = ac.run_id WHERE r.conversation_id = $1 OR r.id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM reference_snapshot_claims WHERE snapshot_id IN (SELECT id FROM reference_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)) OR message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM reference_snapshot_items WHERE snapshot_id IN (SELECT id FROM reference_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)) OR conversation_id = $1`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM reference_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM history_snapshot_items WHERE snapshot_id IN (SELECT id FROM history_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)) OR conversation_id = $1`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM history_snapshots WHERE run_id = ANY($2::text[]) OR run_id IN (SELECT id FROM runs WHERE conversation_id = $1)`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM corrections WHERE comparison_run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[])) OR source_message_id IN (SELECT id FROM messages WHERE conversation_id = $1)`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM indexing_jobs WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1 OR turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[])))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM chunk_embeddings WHERE chunk_id IN (SELECT id FROM history_chunks WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1 OR turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[]))) OR answer_id IN (SELECT id FROM messages WHERE conversation_id = $1 OR turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[]))))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM history_chunks WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = $1 OR turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[]))) OR answer_id IN (SELECT id FROM messages WHERE conversation_id = $1 OR turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[])))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM claim_evidence WHERE claim_id IN (SELECT id FROM answer_claims WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))) OR evidence_id IN (SELECT id FROM evidence_observations WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[])))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM answer_comparisons WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM answer_claims WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM evidence_observations WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM search_queries WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1 OR id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`UPDATE runs SET status = 'failed', error = 'Research context was deleted.' WHERE $1::text IS NOT NULL AND id = ANY($2::text[])`, [conversation, dependentIds]);
      await tx.query(`UPDATE turns SET status = 'failed' WHERE $1::text IS NOT NULL AND id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[]))`, [conversation, dependentIds]);
      await tx.query(`UPDATE jobs SET status = 'failed' WHERE $1::text IS NOT NULL AND run_id = ANY($2::text[])`, [conversation, dependentIds]);
      await tx.query(`INSERT INTO run_events (run_id, kind, data) SELECT id, 'failed', '{"message":"Research context was deleted."}' FROM runs WHERE $1::text IS NOT NULL AND id = ANY($2::text[])`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM messages WHERE $1::text IS NOT NULL AND turn_id IN (SELECT turn_id FROM runs WHERE id = ANY($2::text[])) AND role = 'assistant'`, [conversation, dependentIds]);
      await tx.query(`DELETE FROM jobs WHERE run_id IN (SELECT id FROM runs WHERE conversation_id = $1)`, [conversation]);
      await tx.query(`DELETE FROM runs WHERE conversation_id = $1`, [conversation]);
      await tx.query(`DELETE FROM messages WHERE conversation_id = $1`, [conversation]);
      await tx.query(`DELETE FROM turns WHERE conversation_id = $1`, [conversation]);
      await tx.query('DELETE FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NOT NULL', [conversation, owner]);
      await tx.query('DELETE FROM conversation_cleanup WHERE conversation_id = $1', [conversation]);
      });
    }
    return queued.rows.length;
  }

  async existingAdmission(owner: string, conversation: string, key: string, input: string, verifyCurrent = false, continuationOf: string | null = null) {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    const result = await this.db.query<{ id: string; payload_hash: string }>('SELECT runs.id, turns.payload_hash FROM turns JOIN runs ON runs.turn_id = turns.id WHERE turns.conversation_id = $1 AND turns.idempotency_key = $2', [conversation, key]);
    if (!result.rows.length) return null;
    if (result.rows[0].payload_hash !== payloadHash(input, verifyCurrent, continuationOf)) throw new Conflict('Idempotency key reused with different input');
    return result.rows[0].id;
  }

  async admit(owner: string, conversation: string, key: string, input: string, verifyCurrent = false, continuationOf: string | null = null) {
    const hash = payloadHash(input, verifyCurrent, continuationOf);
    return this.db.transaction(async tx => {
      const owned = await tx.query<{ id: string; timezone: string }>('SELECT id, timezone FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [conversation, owner]);
      if (!owned.rows.length) throw new NotFound('Conversation not found');
      const existing = await tx.query<{ id: string; payload_hash: string }>('SELECT runs.id, turns.payload_hash FROM turns JOIN runs ON runs.turn_id = turns.id WHERE turns.conversation_id = $1 AND turns.idempotency_key = $2', [conversation, key]);
      if (existing.rows.length) {
        if (existing.rows[0].payload_hash !== hash) throw new Conflict('Idempotency key reused with different input');
        return existing.rows[0].id;
      }
      if (continuationOf) {
        const parent = await tx.query<{ id: string }>(`SELECT p.id FROM runs p JOIN conversations pc ON pc.id = p.conversation_id AND pc.owner_id = p.owner_id
          WHERE p.id = $1 AND p.owner_id = $2 AND p.conversation_id = $3 AND p.status = 'incomplete' AND pc.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id JOIN conversations sc ON sc.id = i.conversation_id
              WHERE rs.run_id = p.id AND (rs.revoked = true OR sc.deleted_at IS NOT NULL OR (sc.id <> p.conversation_id AND sc.recall_eligible = false)))
            AND NOT EXISTS (SELECT 1 FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id JOIN conversations sc ON sc.id = i.conversation_id
              WHERE hs.run_id = p.id AND (hs.revoked = true OR sc.deleted_at IS NOT NULL OR (sc.id <> p.conversation_id AND sc.recall_eligible = false)))`, [continuationOf, owner, conversation]);
        if (!parent.rows.length) throw new Conflict('Only an eligible incomplete run in this conversation can be continued');
      }
      const active = await tx.query("SELECT id FROM turns WHERE conversation_id = $1 AND status = 'active'", [conversation]);
      if (active.rows.length) throw new Conflict('Conversation already has an active turn');
      const turn = randomUUID(), run = randomUUID();
      const sequence = await tx.query<{ value: number }>(`INSERT INTO owner_sequences (owner_id, value) VALUES ($1, 1)
        ON CONFLICT (owner_id) DO UPDATE SET value = owner_sequences.value + 1 RETURNING value`, [owner]);
      const ordinal = sequence.rows[0].value;
      await tx.query("INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status) VALUES ($1, $2, $3, $4, $5, $6, 'active')", [turn, conversation, owner, key, hash, input]);
      await tx.query("INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal) VALUES ($1, $2, $3, $4, 'user', $5, $6)", [randomUUID(), conversation, owner, turn, input, ordinal]);
      await tx.query("UPDATE conversations SET title = LEFT(regexp_replace($3, '\\s+', ' ', 'g'), 72) WHERE id = $1 AND owner_id = $2 AND title = 'Conversation'", [conversation, owner, input.trim()]);
      await tx.query("INSERT INTO runs (id, turn_id, conversation_id, owner_id, status, cutoff, verify_current, timezone, parent_run_id) VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)", [run, turn, conversation, owner, ordinal - 1, verifyCurrent, owned.rows[0].timezone, continuationOf]);
      await tx.query("INSERT INTO jobs (run_id, status) VALUES ($1, 'pending')", [run]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'accepted', '{}')", [run]);
      return run;
    });
  }

  async getRun(owner: string, id: string): Promise<Run> {
    const result = await this.db.query<Run>('SELECT r.id, r.conversation_id, r.status, r.cutoff, r.error, r.created_at, r.verify_current, r.timezone, r.parent_run_id FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND c.deleted_at IS NULL', [id, owner]);
    if (!result.rows.length) throw new NotFound('Run not found');
    return result.rows[0];
  }

  async runInput(owner: string, runId: string) {
    const result = await this.db.query<{ input: string }>('SELECT t.input FROM turns t JOIN runs r ON r.turn_id = t.id AND r.owner_id = t.owner_id JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND c.deleted_at IS NULL', [runId, owner]);
    if (!result.rows.length) throw new NotFound('Run not found');
    return result.rows[0].input;
  }

  async activeRun(owner: string, conversation: string) {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    const result = await this.db.query<{ id: string }>("SELECT id FROM runs WHERE conversation_id = $1 AND owner_id = $2 AND status = 'active'", [conversation, owner]);
    return result.rows[0]?.id ?? null;
  }

  async messages(owner: string, conversation: string, after = 0, limit = 50): Promise<Message[]> {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    const rows = (await this.db.query<Message>(`SELECT m.id, m.role, m.content, m.ordinal, m.created_at,
      (SELECT r.id FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id) AS run_id,
      (SELECT r.status FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id) AS run_status, ARRAY(
      SELECT DISTINCT source_id FROM (
        SELECT ce.evidence_id AS source_id FROM runs r JOIN answer_claims ac ON ac.run_id = r.id JOIN claim_evidence ce ON ce.claim_id = ac.id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant'
        UNION ALL
        SELECT jsonb_array_elements_text(cmp.evidence_ids) AS source_id FROM runs r JOIN answer_comparisons cmp ON cmp.run_id = r.id AND cmp.owner_id = r.owner_id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant'
        UNION ALL
        SELECT jsonb_array_elements_text(cmp.historical_evidence_ids) AS source_id FROM runs r JOIN answer_comparisons cmp ON cmp.run_id = r.id AND cmp.owner_id = r.owner_id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant'
      ) citations) AS citation_ids,
      (SELECT hs.id FROM runs r JOIN history_snapshots hs ON hs.run_id = r.id AND hs.owner_id = r.owner_id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant') AS recall_snapshot_id,
      (SELECT rs.id FROM runs r JOIN reference_snapshots rs ON rs.run_id = r.id AND rs.owner_id = r.owner_id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant') AS reference_snapshot_id
      , (SELECT rs.coverage FROM runs r JOIN reference_snapshots rs ON rs.run_id = r.id AND rs.owner_id = r.owner_id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant') AS reference_coverage
      FROM messages m WHERE m.owner_id = $1 AND m.conversation_id = $2 AND m.ordinal > $3 ORDER BY m.ordinal LIMIT $4`, [owner, conversation, after, limit])).rows;
    const revoked = new Set<string>();
    for (const row of rows) if (row.role === 'assistant' && row.run_id && await this.hasRevokedContext(owner, row.run_id)) revoked.add(row.id);
    return rows.filter(row => !revoked.has(row.id));
  }

  async continuationSource(owner: string, runId: string) {
    const run = await this.getRun(owner, runId);
    if (run.status !== 'incomplete') throw new Conflict('Only an incomplete run can be continued');
    const result = await this.db.query<{ conversation_id: string; input: string; verify_current: boolean }>(`SELECT r.conversation_id, t.input, r.verify_current
      FROM runs r JOIN turns t ON t.id = r.turn_id WHERE r.id = $1 AND r.owner_id = $2 AND r.status = 'incomplete'`, [runId, owner]);
    if (!result.rows.length) throw new NotFound('Incomplete run not found');
    return { ...result.rows[0], parent_run_id: runId, eligible: !(await this.hasRevokedContext(owner, runId)) };
  }

  async context(owner: string, runId: string) {
    const run = await this.getRun(owner, runId);
    const current = await this.db.query<Message>(`SELECT m.id, m.role, m.content, m.ordinal, m.created_at
      FROM messages m JOIN runs r ON r.turn_id = m.turn_id
      WHERE r.id = $1 AND r.owner_id = $2 AND m.role = 'user' AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = r.conversation_id AND c.owner_id = r.owner_id AND c.deleted_at IS NULL)`, [runId, owner]);
    if (!current.rows.length) throw new NotFound('Run input not found');
    const history = await this.db.query<Message>(`SELECT * FROM (
      SELECT m.id, m.role, m.content, m.ordinal, m.created_at FROM messages m
      JOIN turns t ON t.id = m.turn_id
      WHERE m.owner_id = $1 AND m.conversation_id = $2 AND m.ordinal <= $3 AND t.status = 'completed'
      ORDER BY m.ordinal DESC LIMIT 200
      ) recent ORDER BY ordinal`, [owner, run.conversation_id, run.cutoff]);
    return { current: current.rows[0], history: history.rows };
  }

  async findReferenceCandidates(owner: string, runId: string, terms: string[], discussionDate: string | null) {
    const run = await this.getRun(owner, runId);
    const patterns = [...new Set(terms.filter(term => term.length >= 2).map(term => `%${term}%`))];
    const result = await this.db.query<Omit<ReferenceCandidate, 'score'>>(`SELECT m.id, m.conversation_id, c.title AS conversation_title,
        m.content, COALESCE(a.content, '') AS answer, a.id AS answer_id, a.ordinal AS answer_ordinal, a.created_at AS answer_created_at, m.ordinal, m.created_at
      FROM messages m JOIN turns t ON t.id = m.turn_id AND t.owner_id = m.owner_id
      JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id AND c.deleted_at IS NULL
      LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
      WHERE m.owner_id = $1 AND m.role = 'user' AND t.status = 'completed' AND c.deleted_at IS NULL
        AND (m.conversation_id = $7 OR c.recall_eligible = true)
        AND m.ordinal <= $2 AND m.created_at <= $3
        AND ($4::date IS NULL OR (m.created_at >= ($4::date::timestamp AT TIME ZONE $5)
          AND m.created_at < (($4::date + 1)::timestamp AT TIME ZONE $5)))
        AND (cardinality($6::text[]) = 0 OR m.content ILIKE ANY($6::text[]) OR COALESCE(a.content, '') ILIKE ANY($6::text[]))
      ORDER BY m.created_at DESC, m.ordinal DESC LIMIT 201`, [owner, run.cutoff, run.created_at, discussionDate, run.timezone, patterns, run.conversation_id]);
    const candidates = result.rows.map(row => {
      const body = `${row.content}\n${row.answer}`.toLowerCase();
      const score = terms.filter(term => body.includes(term)).length;
      return { ...row, score };
    }).filter(candidate => !terms.length || candidate.score > 0).sort((left, right) => right.score - left.score || right.created_at.getTime() - left.created_at.getTime());
    return { candidates, truncated: result.rows.length > 200 };
  }

  async indexedReferenceCandidates(owner: string, runId: string, terms: string[], discussionDate: string | null, vector: number[], space: Pick<EmbeddingSpace, 'id' | 'generation' | 'dimensions'>) {
    const run = await this.getRun(owner, runId);
    const selectedSpace = await this.db.query<{ dimensions: number; normalized: boolean }>('SELECT dimensions, normalized FROM embedding_spaces WHERE id = $1 AND generation = $2 AND status IN (\'active\', \'building\')', [space.id, space.generation]);
    const queryNorm = Math.hypot(...vector);
    if (!selectedSpace.rows.length || selectedSpace.rows[0].dimensions !== space.dimensions || vector.length !== space.dimensions || !vector.every(Number.isFinite) || !queryNorm || (selectedSpace.rows[0].normalized && (queryNorm < 0.99 || queryNorm > 1.01))) throw new Error('Query vector does not match the selected embedding space');
    const result = await this.db.query<Omit<ReferenceCandidate, 'score'> & { source_vector: number[] }>(`SELECT m.id, m.conversation_id, c.title AS conversation_title,
        m.content, COALESCE(a.content, '') AS answer, a.id AS answer_id, a.ordinal AS answer_ordinal, a.created_at AS answer_created_at, m.ordinal, m.created_at,
        ce.vector AS source_vector
      FROM chunk_embeddings ce JOIN history_chunks h ON h.id = ce.chunk_id AND h.owner_id = ce.owner_id AND h.conversation_id = ce.conversation_id
      JOIN messages m ON m.id = h.message_id AND m.owner_id = h.owner_id
      JOIN turns t ON t.id = m.turn_id AND t.owner_id = m.owner_id
      JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
      JOIN runs current_run ON current_run.id = $1 AND current_run.owner_id = $2
      LEFT JOIN messages a ON a.id = h.answer_id AND a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
      WHERE ce.owner_id = $2 AND ce.space_id = $3 AND ce.generation = $4 AND ce.status = 'ready' AND ce.dimensions = $5
        AND ce.source_hash = h.source_hash AND h.source_hash = encode(sha256(convert_to(m.content || chr(31) || COALESCE(a.content, ''), 'UTF8')), 'hex')
        AND h.content_hash = encode(sha256(convert_to(h.content, 'UTF8')), 'hex')
        AND t.status = 'completed' AND c.deleted_at IS NULL AND (c.id = current_run.conversation_id OR c.recall_eligible = true)
        AND m.ordinal <= current_run.cutoff AND m.created_at <= current_run.created_at
        AND ($6::date IS NULL OR (m.created_at >= ($6::date::timestamp AT TIME ZONE current_run.timezone) AND m.created_at < (($6::date + 1)::timestamp AT TIME ZONE current_run.timezone)))
      LIMIT 10001`, [runId, owner, space.id, space.generation, space.dimensions, discussionDate]);
    const byMessage = new Map<string, VectorReferenceCandidate>();
    for (const row of result.rows) {
      const source = typeof row.source_vector === 'string' ? JSON.parse(row.source_vector) as number[] : row.source_vector;
      if (!Array.isArray(source) || source.length !== vector.length || !source.every(Number.isFinite)) continue;
      const norm = Math.hypot(...source);
      if (!norm) continue;
      const similarity = source.reduce((sum, value, index) => sum + value * vector[index], 0) / norm;
      if (similarity < 0.15) continue;
      const existing = byMessage.get(row.id);
      if (!existing || similarity > existing.similarity) byMessage.set(row.id, { ...row, score: terms.filter(term => `${row.content}\n${row.answer}`.toLocaleLowerCase().includes(term.toLocaleLowerCase())).length, similarity });
    }
    return { candidates: [...byMessage.values()].sort((left, right) => right.similarity - left.similarity || right.created_at.getTime() - left.created_at.getTime()).slice(0, 200), truncated: result.rows.length > 10_000 };
  }

  async embeddingCoverage(owner: string, runId: string, space: Pick<EmbeddingSpace, 'id' | 'generation'>) {
    const run = await this.getRun(owner, runId);
    const result = await this.db.query<{ total: number; indexed: number }>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE EXISTS (SELECT 1 FROM indexing_jobs j WHERE j.message_id = m.id AND j.owner_id = m.owner_id AND j.space_id = $2 AND j.generation = $3 AND j.status = 'completed'
        AND j.source_hash = encode(sha256(convert_to(m.content || chr(31) || COALESCE(a.content, ''), 'UTF8')), 'hex')))::int AS indexed
      FROM messages m JOIN turns t ON t.id = m.turn_id JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
      WHERE m.owner_id = $1 AND m.role = 'user' AND t.status = 'completed' AND m.ordinal <= $4 AND m.created_at <= $5
        AND c.deleted_at IS NULL AND (c.id = $6 OR c.recall_eligible = true)`, [owner, space.id, space.generation, run.cutoff, run.created_at, run.conversation_id]);
    return { total: result.rows[0].total, indexed: result.rows[0].indexed, complete: result.rows[0].total === result.rows[0].indexed };
  }

  async saveReferenceSnapshot(owner: string, runId: string, status: 'resolved' | 'clarification_needed' | 'no_match' | 'incomplete', coverage: 'complete' | 'incomplete', discussionDate: string | null, comparisonDate: string | null, candidates: ReferenceCandidate[]) {
    const id = randomUUID();
    return this.db.transaction(async tx => {
      const run = await tx.query<{ cutoff: number }>("SELECT r.cutoff FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id AND c.deleted_at IS NULL WHERE r.id = $1 AND r.owner_id = $2 AND r.status = 'active'", [runId, owner]);
      if (!run.rows.length) throw new NotFound('Active run not found');
      await tx.query(`INSERT INTO reference_snapshots (id, run_id, owner_id, status, coverage, discussion_date, comparison_date)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, runId, owner, status, coverage, discussionDate, comparisonDate]);
      for (const [index, candidate] of candidates.slice(0, 5).entries()) {
        await tx.query(`INSERT INTO reference_snapshot_items (snapshot_id, message_id, content_hash, recorded_at, recorded_ordinal, conversation_id, rank,
            answer_id, answer_hash, answer_recorded_at, answer_recorded_ordinal)
          SELECT $1, m.id, encode(sha256(convert_to(m.content, 'UTF8')), 'hex'), m.created_at, m.ordinal, m.conversation_id, $7,
            a.id, CASE WHEN a.id IS NULL THEN NULL ELSE encode(sha256(convert_to(a.content, 'UTF8')), 'hex') END, a.created_at, a.ordinal
          FROM messages m JOIN runs r ON r.id = $2 AND r.owner_id = $3
          LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
          JOIN conversations source_conversation ON source_conversation.id = m.conversation_id AND source_conversation.owner_id = m.owner_id AND source_conversation.deleted_at IS NULL
          WHERE m.id = $4 AND m.owner_id = $3 AND m.role = 'user' AND m.ordinal <= r.cutoff AND m.ordinal <= $5
          AND (m.conversation_id = r.conversation_id OR source_conversation.recall_eligible = true)
          AND m.created_at <= r.created_at AND m.conversation_id = $6`,
        [id, runId, owner, candidate.id, run.rows[0].cutoff, candidate.conversation_id, index + 1]);
        await tx.query(`INSERT INTO reference_snapshot_claims (snapshot_id, message_id, source_claim_id, claim, claim_hash)
          SELECT $1, i.message_id, ac.id, ac.claim, encode(sha256(convert_to(ac.claim, 'UTF8')), 'hex')
          FROM reference_snapshot_items i JOIN messages a ON a.id = i.answer_id AND a.owner_id = $2
          JOIN runs ar ON ar.turn_id = a.turn_id AND ar.owner_id = a.owner_id
          JOIN answer_claims ac ON ac.run_id = ar.id AND ac.owner_id = ar.owner_id
          WHERE i.snapshot_id = $1 AND i.message_id = $3 ON CONFLICT DO NOTHING`, [id, owner, candidate.id]);
        await tx.query(`INSERT INTO reference_snapshot_evidence (snapshot_id, source_claim_id, evidence_id, title, url, excerpt, excerpt_hash, observed_at)
          SELECT $1, sc.source_claim_id, eo.id, eo.title, eo.url, eo.excerpt, eo.excerpt_hash, eo.observed_at
          FROM reference_snapshot_claims sc JOIN claim_evidence ce ON ce.claim_id = sc.source_claim_id
          JOIN evidence_observations eo ON eo.id = ce.evidence_id AND eo.owner_id = $2
          WHERE sc.snapshot_id = $1 AND sc.message_id = $3 ON CONFLICT DO NOTHING`, [id, owner, candidate.id]);
      }
      return id;
    });
  }

  async referenceSnapshot(owner: string, snapshotId: string): Promise<ReferenceSnapshot> {
    const snapshot = await this.db.query<Omit<ReferenceSnapshot, 'items'>>(`SELECT id, run_id, status, coverage, discussion_date::text, comparison_date::text
      FROM reference_snapshots WHERE id = $1 AND owner_id = $2`, [snapshotId, owner]);
    if (!snapshot.rows.length) throw new NotFound('Reference snapshot not found');
    const run = await this.getRun(owner, snapshot.rows[0].run_id);
    const result = await this.db.query<{ total: number; valid: number }>(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE m.owner_id = $2 AND m.role = 'user' AND m.ordinal = i.recorded_ordinal
          AND m.created_at = i.recorded_at AND m.conversation_id = i.conversation_id
          AND m.ordinal <= $3 AND m.created_at <= $4 AND EXISTS (SELECT 1 FROM conversations source_c WHERE source_c.id = m.conversation_id AND source_c.owner_id = $2 AND source_c.deleted_at IS NULL AND (source_c.id = $5 OR source_c.recall_eligible = true))
          AND encode(sha256(convert_to(m.content, 'UTF8')), 'hex') = i.content_hash
          AND (i.answer_id IS NULL OR EXISTS (SELECT 1 FROM messages a WHERE a.id = i.answer_id AND a.owner_id = $2
            AND a.role = 'assistant' AND a.turn_id = m.turn_id AND a.ordinal = i.answer_recorded_ordinal
            AND a.created_at = i.answer_recorded_at AND encode(sha256(convert_to(a.content, 'UTF8')), 'hex') = i.answer_hash)))::int AS valid
      FROM reference_snapshot_items i LEFT JOIN messages m ON m.id = i.message_id WHERE i.snapshot_id = $1`, [snapshotId, owner, run.cutoff, run.created_at, run.conversation_id]);
    if (result.rows[0].total !== result.rows[0].valid) return { ...snapshot.rows[0], coverage: 'incomplete', items: [] };
    const claims = await this.db.query<{ total: number; valid: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM reference_snapshot_items i JOIN messages a ON a.id = i.answer_id AND a.owner_id = $2
        JOIN runs ar ON ar.turn_id = a.turn_id AND ar.owner_id = a.owner_id
        JOIN answer_claims ac ON ac.id = sc.source_claim_id AND ac.run_id = ar.id AND ac.owner_id = ar.owner_id
        WHERE i.snapshot_id = sc.snapshot_id AND i.message_id = sc.message_id
          AND encode(sha256(convert_to(ac.claim, 'UTF8')), 'hex') = sc.claim_hash
          AND ac.claim = sc.claim))::int AS valid
      FROM reference_snapshot_claims sc WHERE sc.snapshot_id = $1`, [snapshotId, owner]);
    const evidence = await this.db.query<{ total: number; valid: number }>(`SELECT count(*)::int AS total, count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM reference_snapshot_claims sc JOIN reference_snapshot_items i ON i.snapshot_id = sc.snapshot_id AND i.message_id = sc.message_id
        JOIN messages a ON a.id = i.answer_id AND a.owner_id = $2 JOIN runs ar ON ar.turn_id = a.turn_id AND ar.owner_id = a.owner_id
        JOIN claim_evidence ce ON ce.claim_id = sc.source_claim_id AND ce.evidence_id = se.evidence_id
        JOIN evidence_observations eo ON eo.id = se.evidence_id AND eo.owner_id = ar.owner_id AND eo.run_id = ar.id
        WHERE sc.snapshot_id = se.snapshot_id AND sc.source_claim_id = se.source_claim_id
          AND eo.title = se.title AND eo.url = se.url AND eo.excerpt = se.excerpt AND eo.observed_at = se.observed_at
          AND eo.excerpt_hash = se.excerpt_hash
          AND encode(sha256(convert_to(eo.excerpt, 'UTF8')), 'hex') = se.excerpt_hash))::int AS valid
      FROM reference_snapshot_evidence se WHERE se.snapshot_id = $1`, [snapshotId, owner]);
    if (claims.rows[0].total !== claims.rows[0].valid || evidence.rows[0].total !== evidence.rows[0].valid) return { ...snapshot.rows[0], coverage: 'incomplete', items: [] };
    const items = await this.db.query<Omit<ReferenceSnapshotItem, 'historical_claims' | 'corrections'>>(`SELECT m.id, m.conversation_id, c.title AS conversation_title,
        m.content, COALESCE(a.content, '') AS answer, a.id AS answer_id, a.ordinal AS answer_ordinal, a.created_at AS answer_created_at, m.ordinal, m.created_at, i.rank
      FROM reference_snapshot_items i JOIN messages m ON m.id = i.message_id AND m.owner_id = $2
      JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
      LEFT JOIN messages a ON a.turn_id = m.turn_id AND a.owner_id = m.owner_id AND a.role = 'assistant'
      WHERE i.snapshot_id = $1 ORDER BY i.rank`, [snapshotId, owner]);
    const hydrated: ReferenceSnapshotItem[] = [];
    for (const item of items.rows) {
      const support = item.answer_id ? await this.db.query<{ claim: string; evidence_id: string; title: string; url: string; excerpt: string; observed_at: Date }>(`SELECT sc.claim, se.evidence_id, se.title, se.url, se.excerpt, se.observed_at
        FROM reference_snapshot_claims sc LEFT JOIN reference_snapshot_evidence se ON se.snapshot_id = sc.snapshot_id AND se.source_claim_id = sc.source_claim_id
        WHERE sc.snapshot_id = $1 AND sc.message_id = $2 ORDER BY sc.source_claim_id, se.observed_at, se.evidence_id`, [snapshotId, item.id]) : { rows: [] };
      const claims = new Map<string, HistoricalClaimEvidence>();
      for (const source of support.rows) {
        const claim = claims.get(source.claim) || { claim: source.claim, evidence: [] };
        if (source.evidence_id) claim.evidence.push({ id: source.evidence_id, title: source.title, url: source.url, excerpt: source.excerpt, observed_at: source.observed_at });
        claims.set(source.claim, claim);
      }
      const corrections = await this.db.query<HistoricalCorrection>(`SELECT DISTINCT id, correction, created_at FROM corrections
        WHERE owner_id = $1 AND source_message_id = ANY($2::text[]) ORDER BY created_at, id`, [owner, [item.id, ...(item.answer_id ? [item.answer_id] : [])]]);
      hydrated.push({ ...item, historical_claims: [...claims.values()], corrections: corrections.rows });
    }
    return { ...snapshot.rows[0], items: hydrated };
  }

  async pendingReferenceSnapshot(owner: string, runId: string) {
    const run = await this.getRun(owner, runId);
    const result = await this.db.query<{ id: string }>(`SELECT rs.id FROM messages m
      JOIN reference_snapshots rs ON rs.run_id = (SELECT r.id FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id)
      WHERE m.owner_id = $1 AND m.conversation_id = $2 AND m.role = 'assistant' AND m.ordinal <= $3
        AND rs.status = 'clarification_needed'
        AND m.ordinal = (SELECT max(latest.ordinal) FROM messages latest WHERE latest.owner_id = $1 AND latest.conversation_id = $2 AND latest.ordinal <= $3)
      ORDER BY m.ordinal DESC LIMIT 1`, [owner, run.conversation_id, run.cutoff]);
    return result.rows[0]?.id ?? null;
  }

  async saveReferenceChoice(owner: string, runId: string, previousSnapshotId: string, rank: number) {
    const previous = await this.referenceSnapshot(owner, previousSnapshotId);
    if (previous.status !== 'clarification_needed' || previous.coverage !== 'complete') throw new Conflict('Reference choices are no longer available');
    const candidate = previous.items.find(item => item.rank === rank);
    if (!candidate) throw new NotFound('Reference choice not found');
    return this.saveReferenceSnapshot(owner, runId, 'resolved', previous.coverage, previous.discussion_date, previous.comparison_date, [{ ...candidate, score: 0 }]);
  }

  async startSearch(owner: string, runId: string, query: string) {
    const id = randomUUID();
    const result = await this.db.query(`INSERT INTO search_queries (id, run_id, owner_id, query, status)
      SELECT $3, r.id, r.owner_id, $4, 'started' FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND r.status = 'active' AND c.deleted_at IS NULL RETURNING id`, [runId, owner, id, query]);
    if (!result.rows.length) throw new NotFound('Active run not found');
    return id;
  }

  async finishSearch(owner: string, runId: string, id: string, status: 'completed' | 'failed') {
    await this.db.query(`UPDATE search_queries SET status = $4 WHERE id = $1 AND owner_id = $2 AND run_id = $3 AND status = 'started'`, [id, owner, runId, status]);
  }

  async recallYears(owner: string, runId: string, month: number, day: number) {
    const run = await this.getRun(owner, runId);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(day) || day < 1 || day > 31) throw new Error('Invalid local date');
    const rows = await this.db.query<{ year: number }>(`SELECT DISTINCT EXTRACT(YEAR FROM created_at AT TIME ZONE $3)::int AS year
      FROM messages m WHERE owner_id = $1 AND role = 'user' AND ordinal <= $2
        AND created_at <= $6 AND EXTRACT(MONTH FROM created_at AT TIME ZONE $3) = $4
        AND EXTRACT(DAY FROM created_at AT TIME ZONE $3) = $5 AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND sc.deleted_at IS NULL AND (sc.id = $7 OR sc.recall_eligible = true)) ORDER BY year DESC LIMIT 21`, [owner, run.cutoff, run.timezone, month, day, run.created_at, run.conversation_id]);
    return rows.rows.map(row => row.year);
  }

  async questionsOnLocalDate(owner: string, runId: string, date: string, after = 0, limit = 50) {
    const run = await this.getRun(owner, runId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid local date');
    const parsed = new Date(`${date}T00:00:00.000Z`);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Invalid local date');
    if (!Number.isInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid pagination');
    const predicate = `m.owner_id = $1 AND m.role = 'user' AND m.ordinal <= $2
      AND EXISTS (SELECT 1 FROM conversations sc WHERE sc.id = m.conversation_id AND sc.deleted_at IS NULL AND (sc.id = $5 OR sc.recall_eligible = true))
      AND m.created_at >= ($3::date::timestamp AT TIME ZONE $4)
      AND m.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4)`;
    const countParams = [owner, run.cutoff, date, run.timezone, run.conversation_id];
    const params = [...countParams, after, limit + 1];
    const count = await this.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM messages m WHERE ${predicate}`, countParams);
    if (after) {
      const cursor = await this.db.query(`SELECT m.id FROM messages m WHERE ${predicate} AND m.ordinal = $6`, [...countParams, after]);
      if (!cursor.rows.length) throw new Error('Invalid pagination cursor');
    }
    const page = await this.db.query<{ id: string; conversation_id: string; content: string; ordinal: number; created_at: Date; source_timezone: string | null }>(`SELECT m.id, m.conversation_id, m.content, m.ordinal, m.created_at, (SELECT r.timezone FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id) AS source_timezone FROM messages m WHERE ${predicate}
      AND ($6::int = 0 OR (m.created_at, m.ordinal) > (SELECT c.created_at, c.ordinal FROM messages c WHERE c.owner_id = $1 AND c.ordinal = $6))
      ORDER BY m.created_at, m.ordinal LIMIT $7`, params);
    const messages = page.rows.slice(0, limit);
    return { date, timezone: run.timezone, total: count.rows[0].total, messages, next: page.rows.length > limit ? messages[messages.length - 1].ordinal : null };
  }

  async prepareDateRecall(owner: string, runId: string, date: string) {
    const existing = await this.db.query<{ id: string; local_date: string }>('SELECT id, local_date::text FROM history_snapshots WHERE run_id = $1 AND owner_id = $2', [runId, owner]);
    if (existing.rows.length) {
      if (existing.rows[0].local_date !== date) throw new Conflict('Run already has a different history snapshot');
      return existing.rows[0].id;
    }
    const run = await this.getRun(owner, runId);
    if (run.status !== 'active') throw new Conflict('Run is no longer active');
    const result = await this.questionsOnLocalDate(owner, runId, date, 0, 1);
    const id = randomUUID();
    const inserted = await this.db.transaction(async tx => {
      const saved = await tx.query(`INSERT INTO history_snapshots (id, run_id, owner_id, local_date, timezone, cutoff, status, total)
        SELECT $1, id, owner_id, $4, $5, $6, $7, $8 FROM runs WHERE id = $2 AND owner_id = $3 AND status = 'active'
        ON CONFLICT (run_id) DO NOTHING RETURNING id`, [id, runId, owner, date, run.timezone, run.cutoff, result.total ? 'resolved' : 'no_match', result.total]);
      if (saved.rows.length) await tx.query(`INSERT INTO history_snapshot_items (snapshot_id, message_id, content_hash, recorded_at, recorded_ordinal, conversation_id, source_timezone)
        SELECT $1, m.id, encode(sha256(convert_to(m.content, 'UTF8')), 'hex'), m.created_at, m.ordinal, m.conversation_id,
          (SELECT r.timezone FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id) FROM messages m
        WHERE m.owner_id = $2 AND m.role = 'user' AND m.ordinal <= $3
          AND m.created_at >= ($4::date::timestamp AT TIME ZONE $5)
          AND m.created_at < (($4::date + 1)::timestamp AT TIME ZONE $5)
          AND EXISTS (SELECT 1 FROM conversations sc JOIN runs current_run ON current_run.id = $6 WHERE sc.id = m.conversation_id AND sc.deleted_at IS NULL AND (sc.id = current_run.conversation_id OR sc.recall_eligible = true))`, [id, owner, run.cutoff, date, run.timezone, runId]);
      return saved.rows.length > 0;
    });
    if (inserted) return id;
    const concurrent = await this.db.query<{ id: string; local_date: string }>('SELECT id, local_date::text FROM history_snapshots WHERE run_id = $1 AND owner_id = $2', [runId, owner]);
    if (concurrent.rows[0]?.local_date === date) return concurrent.rows[0].id;
    throw new Conflict('Run is no longer active or has a different history snapshot');
  }

  async dateRecallSnapshot(owner: string, snapshotId: string, after = 0, limit = 50) {
    const result = await this.db.query<{ run_id: string; local_date: string; status: string; total: number; timezone: string; cutoff: number }>(`SELECT run_id, local_date::text, status, total, timezone, cutoff FROM history_snapshots WHERE id = $1 AND owner_id = $2`, [snapshotId, owner]);
    const snapshot = result.rows[0];
    if (!snapshot) throw new NotFound('History snapshot not found');
    const run = await this.getRun(owner, snapshot.run_id);
    if (run.cutoff !== snapshot.cutoff || run.timezone !== snapshot.timezone) throw new Error('History snapshot context mismatch');
    const page = await this.questionsOnLocalDate(owner, snapshot.run_id, snapshot.local_date, after, limit);
    const verified = await this.db.query<{ total: number; valid: number }>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE m.owner_id = $2 AND m.role = 'user' AND m.created_at = i.recorded_at
        AND m.ordinal = i.recorded_ordinal AND m.conversation_id = i.conversation_id
        AND (SELECT r.timezone FROM runs r WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id) IS NOT DISTINCT FROM i.source_timezone
        AND encode(sha256(convert_to(m.content, 'UTF8')), 'hex') = i.content_hash)::int AS valid
      FROM history_snapshot_items i LEFT JOIN messages m ON m.id = i.message_id WHERE i.snapshot_id = $1`, [snapshotId, owner]);
    const coverage = page.total === snapshot.total && verified.rows[0].total === snapshot.total && verified.rows[0].valid === snapshot.total ? 'complete' : 'incomplete';
    const messages = coverage === 'complete' ? page.messages.map(message => {
      const hasRelativeDate = /\b(today|yesterday|last\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/i.test(message.content);
      const relative_date = !hasRelativeDate ? null : message.source_timezone
        ? { ...interpretDateReference(message.content, new Date(message.created_at), message.source_timezone), anchor_time: message.created_at, timezone: message.source_timezone }
        : { status: 'timezone_unavailable' as const, anchor_time: message.created_at, timezone: null };
      return { ...message, relative_date };
    }) : [];
    return { id: snapshotId, runId: snapshot.run_id, status: snapshot.status, coverage, expectedTotal: snapshot.total, ...page,
      messages, next: coverage === 'complete' ? page.next : null };
  }

  async recordProgress(owner: string, runId: string, stage: 'searching' | 'reviewing') {
    const result = await this.db.query(`INSERT INTO run_events (run_id, kind, data)
      SELECT r.id, 'progress', $3 FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND r.status = 'active' AND c.deleted_at IS NULL RETURNING id`,
      [runId, owner, JSON.stringify({ stage })]);
    return result.rows.length > 0;
  }

  async registerEvidence(owner: string, runId: string, observations: SearchResult[], searchQueryId?: string) {
    return this.db.transaction(async tx => {
      const run = await tx.query<{ status: string }>('SELECT r.status FROM runs r JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE r.id = $1 AND r.owner_id = $2 AND c.deleted_at IS NULL', [runId, owner]);
      if (!run.rows.length) throw new NotFound('Run not found');
      if (run.rows[0].status !== 'active') throw new Conflict('Run is no longer active');
      if (searchQueryId) {
        const query = await tx.query("SELECT id FROM search_queries WHERE id = $1 AND run_id = $2 AND owner_id = $3 AND status = 'completed'", [searchQueryId, runId, owner]);
        if (!query.rows.length) throw new Conflict('Search query is not authorized for this run');
      }
      const registered = [];
      for (const observation of observations) {
        const id = randomUUID();
        const hash = createHash('sha256').update(observation.excerpt).digest('hex');
        await tx.query(`INSERT INTO evidence_observations (id, run_id, owner_id, url, title, excerpt, excerpt_hash, observed_at, provider, representation, search_query_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, runId, owner, observation.url, observation.title, observation.excerpt, hash, observation.observedAt, observation.provider, observation.representation, searchQueryId || null]);
        registered.push({ id, ...observation, excerptHash: hash });
      }
      return registered;
    });
  }

  async evidence(owner: string, id: string) {
    const result = await this.db.query('SELECT eo.id, eo.run_id, eo.url, eo.title, eo.excerpt, eo.excerpt_hash, eo.observed_at, eo.provider, eo.representation, eo.search_query_id FROM evidence_observations eo JOIN runs r ON r.id = eo.run_id AND r.owner_id = eo.owner_id JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id WHERE eo.id = $1 AND eo.owner_id = $2 AND c.deleted_at IS NULL', [id, owner]);
    if (!result.rows.length) throw new NotFound('Evidence not found');
    return result.rows[0];
  }

  async eventCursor(owner: string, runId: string, cursor: number) {
    await this.getRun(owner, runId);
    if (await this.hasRevokedContext(owner, runId)) return { valid: false, kind: null as string | null };
    if (!cursor) return { valid: true, kind: null as string | null };
    const result = await this.db.query<{ kind: string }>('SELECT kind FROM run_events WHERE run_id = $1 AND id = $2', [runId, cursor]);
    return { valid: result.rows.length > 0, kind: result.rows[0]?.kind ?? null };
  }

  async terminalSnapshot(owner: string, runId: string) {
    const run = await this.getRun(owner, runId);
    if (await this.hasRevokedContext(owner, runId)) return null;
    if (run.status === 'active') return null;
    if (run.status === 'completed') {
      const result = await this.db.query<{ content: string }>(`SELECT m.content FROM messages m JOIN runs r ON r.turn_id = m.turn_id
        WHERE r.id = $1 AND r.owner_id = $2 AND m.owner_id = $2 AND m.role = 'assistant'`, [runId, owner]);
      if (!result.rows.length) throw new Error('Completed run has no answer');
      return { kind: 'completed', data: JSON.stringify({ content: result.rows[0].content }) };
    }
    if (run.status === 'incomplete') {
      const result = await this.db.query<{ content: string }>(`SELECT m.content FROM messages m JOIN runs r ON r.turn_id = m.turn_id
        WHERE r.id = $1 AND r.owner_id = $2 AND m.owner_id = $2 AND m.role = 'assistant'`, [runId, owner]);
      if (!result.rows.length) throw new Error('Incomplete run has no limitation message');
      return { kind: 'incomplete', data: JSON.stringify({ content: result.rows[0].content }) };
    }
    if (run.status === 'failed') return { kind: 'failed', data: JSON.stringify({ message: run.error || 'The run failed.' }) };
    if (run.status === 'cancelled') return { kind: 'cancelled', data: '{}' };
    throw new Error('Unknown terminal status');
  }

  async events(owner: string, id: string, after = 0) {
    await this.getRun(owner, id);
    if (await this.hasRevokedContext(owner, id)) return [];
    return (await this.db.query<{ id: number; kind: string; data: string }>('SELECT id, kind, data FROM run_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 100', [id, after])).rows;
  }

  async publish(owner: string, runId: string, content: string, claims: { claim: string; evidenceIds: string[] }[] = [], comparisons: ComparisonClaim[] = []) {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string; conversation_id: string; status: string; input: string }>('SELECT r.turn_id, r.conversation_id, r.status, t.input FROM runs r JOIN turns t ON t.id = r.turn_id JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id AND c.deleted_at IS NULL WHERE r.id = $1 AND r.owner_id = $2', [runId, owner]);
      const run = result.rows[0];
      if (!run) throw new NotFound('Run not found');
      if (run.status !== 'active') return false;
      const revokedReferences = await tx.query(`SELECT 1 FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id
        JOIN conversations source_c ON source_c.id = i.conversation_id
        WHERE rs.run_id = $1 AND rs.owner_id = $2 AND (rs.revoked = true OR source_c.deleted_at IS NOT NULL OR (source_c.id <> $3 AND source_c.recall_eligible = false)) LIMIT 1`, [runId, owner, run.conversation_id]);
      const revokedRecall = await tx.query(`SELECT 1 FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id
        JOIN conversations source_c ON source_c.id = i.conversation_id
        WHERE hs.run_id = $1 AND hs.owner_id = $2 AND (hs.revoked = true OR source_c.deleted_at IS NOT NULL OR (source_c.id <> $3 AND source_c.recall_eligible = false)) LIMIT 1`, [runId, owner, run.conversation_id]);
      const revokedSnapshot = await tx.query(`SELECT 1 FROM reference_snapshots WHERE run_id = $1 AND revoked = true UNION ALL SELECT 1 FROM history_snapshots WHERE run_id = $1 AND revoked = true LIMIT 1`, [runId]);
      if (revokedReferences.rows.length || revokedRecall.rows.length || revokedSnapshot.rows.length) throw new Conflict('Selected history is no longer eligible for reuse');
      for (const claim of claims) {
        if (!claim.claim.trim() || !claim.evidenceIds.length || new Set(claim.evidenceIds).size !== claim.evidenceIds.length) throw new Conflict('Invalid answer claim');
        for (const evidenceId of claim.evidenceIds) {
          const evidence = await tx.query('SELECT id FROM evidence_observations WHERE id = $1 AND owner_id = $2 AND run_id = $3', [evidenceId, owner, runId]);
          if (!evidence.rows.length) throw new Conflict('Answer cites evidence outside this run');
        }
        const claimId = randomUUID();
        await tx.query('INSERT INTO answer_claims (id, run_id, owner_id, claim) VALUES ($1, $2, $3, $4)', [claimId, runId, owner, claim.claim]);
        for (const evidenceId of claim.evidenceIds) await tx.query('INSERT INTO claim_evidence (claim_id, evidence_id) VALUES ($1, $2)', [claimId, evidenceId]);
      }
      let correctionTarget: string | null = null;
      if (comparisons.length) {
        const reference = await tx.query<{ snapshot_id: string; message_id: string; answer_id: string | null; historical_evidence_count: number }>(`SELECT s.id AS snapshot_id, i.message_id, i.answer_id,
          (SELECT count(*)::int FROM reference_snapshot_evidence se JOIN reference_snapshot_claims sc ON sc.snapshot_id = se.snapshot_id AND sc.source_claim_id = se.source_claim_id WHERE se.snapshot_id = s.id AND sc.message_id = i.message_id) AS historical_evidence_count
          FROM reference_snapshots s JOIN reference_snapshot_items i ON i.snapshot_id = s.id
          WHERE s.run_id = $1 AND s.owner_id = $2 AND s.status = 'resolved'`, [runId, owner]);
        const historicalEvidenceCount = reference.rows.length === 1 ? reference.rows[0].historical_evidence_count : 0;
        correctionTarget = reference.rows.length === 1 ? reference.rows[0].answer_id : null;
        for (const comparison of comparisons) {
          if (!comparison.subject.trim() || !comparison.attribute.trim() || !comparison.statement.trim() || new Set(comparison.evidenceIds).size !== comparison.evidenceIds.length) throw new Conflict('Invalid structured comparison');
          if (comparison.baselineConflict && ['supported_change', 'prior_error', 'no_relevant_update_found'].includes(comparison.outcome)) throw new Conflict('Conflicting baselines cannot publish a definitive comparison');
          if (['supported_change', 'prior_error', 'no_relevant_update_found'].includes(comparison.outcome) && comparison.baselineOrigin === 'unsupported') throw new Conflict('A definitive comparison requires an attributed or evidenced baseline');
          if (comparison.baselineOrigin === 'user_reported' && (!comparison.userQuote || !run.input.toLocaleLowerCase().includes(comparison.userQuote.toLocaleLowerCase()))) throw new Conflict('A user-reported baseline must quote text supplied in this turn');
          if (comparison.baselineOrigin === 'reconstructed' && (!comparison.baselineStatement || !comparison.baselinePeriod || !comparison.historicalEvidenceIds.length)) throw new Conflict('A reconstructed baseline requires a statement, historical period, and source evidence');
          let hasStoredBaselineEvidence = false;
          let hasReconstructedBaselineEvidence = false;
          for (const historicalId of comparison.historicalEvidenceIds) {
            if (comparison.baselineOrigin === 'reconstructed' || comparison.baselineOrigin === 'mixed') {
              const evidence = await tx.query<{ title: string; excerpt: string }>('SELECT title, excerpt FROM evidence_observations WHERE id = $1 AND owner_id = $2 AND run_id = $3', [historicalId, owner, runId]);
              if (evidence.rows.length) {
                const historicalText = evidence.rows[0].excerpt;
                if (!comparison.baselinePeriod || !/\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(historicalText) || !historicalText.toLocaleLowerCase().includes(comparison.baselinePeriod.toLocaleLowerCase())) throw new Conflict('Reconstructed evidence must identify the stated historical period');
                hasReconstructedBaselineEvidence = true;
                continue;
              }
            }
            const historical = reference.rows.length === 1 ? await tx.query('SELECT evidence_id FROM reference_snapshot_evidence WHERE snapshot_id = $1 AND evidence_id = $2', [reference.rows[0].snapshot_id, historicalId]) : { rows: [] };
            if (!historical.rows.length) throw new Conflict('Baseline cites evidence outside the historical snapshot and current run');
            hasStoredBaselineEvidence = true;
          }
          if (comparison.baselineOrigin === 'stored_evidence' && !hasStoredBaselineEvidence) throw new Conflict('A stored-evidence baseline must cite the historical snapshot');
          if (comparison.baselineOrigin === 'reconstructed' && !hasReconstructedBaselineEvidence) throw new Conflict('A reconstructed baseline must cite dated historical support found in this run');
          if (comparison.baselineOrigin === 'mixed' && (!hasStoredBaselineEvidence || !hasReconstructedBaselineEvidence)) throw new Conflict('A mixed baseline must cite both stored and reconstructed evidence');
          if (/price|cost|fee|subscription/i.test(comparison.attribute) && ['supported_change', 'prior_error', 'no_relevant_update_found'].includes(comparison.outcome)) {
            const keys = ['plan', 'currency', 'billingPeriod', 'seats', 'region', 'taxBasis'];
            const prior = comparison.priorDimensions || {}, current = comparison.currentDimensions || {};
            if (keys.some(key => prior[key] === undefined || current[key] === undefined || String(prior[key]).toLocaleLowerCase() !== String(current[key]).toLocaleLowerCase())) throw new Conflict('Definitive price comparisons require matching plan, currency, billing period, seats, region, and tax basis');
          }
          if (['supported_change', 'prior_error', 'no_relevant_update_found'].includes(comparison.outcome) && !comparison.evidenceIds.length) throw new Conflict('A definitive comparison requires current evidence');
          const comparisonEvidence: { title: string; excerpt: string }[] = [];
          for (const evidenceId of comparison.evidenceIds) {
            const evidence = await tx.query<{ title: string; excerpt: string }>('SELECT title, excerpt FROM evidence_observations WHERE id = $1 AND owner_id = $2 AND run_id = $3', [evidenceId, owner, runId]);
            if (!evidence.rows.length) throw new Conflict('Comparison cites evidence outside this run');
            comparisonEvidence.push(evidence.rows[0]);
          }
          if (comparison.outcome === 'prior_error' && /price|cost|fee|subscription/i.test(comparison.attribute) && !comparisonEvidence.some(item => /\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(`${item.title} ${item.excerpt}`))) throw new Conflict('A prior-price correction requires evidence that identifies the historical period');
          if (comparison.outcome === 'prior_error' && (!correctionTarget || !historicalEvidenceCount || !comparison.evidenceIds.length)) throw new Conflict('A correction requires a resolved prior answer with attached historical evidence and current evidence');
          const baselineStatement = comparison.baselineOrigin === 'user_reported'
            ? `User-reported quote (not independently verified): ${comparison.userQuote}`
            : comparison.baselineOrigin === 'reconstructed' && !/reconstructed from evidence found now/i.test(comparison.baselineStatement || '')
              ? `Reconstructed from evidence found now for ${comparison.baselinePeriod}; not verified during the original discussion: ${comparison.baselineStatement}`
              : comparison.baselineOrigin === 'mixed' && !/mixed baseline from sources attached then/i.test(comparison.baselineStatement || '')
                ? `Mixed baseline from sources attached then and historical evidence found now: ${comparison.baselineStatement || 'see cited sources'}`
                : comparison.baselineStatement || null;
          await tx.query(`INSERT INTO answer_comparisons (id, run_id, owner_id, subject, attribute, outcome, statement, evidence_ids, prior_dimensions, current_dimensions,
              baseline_origin, baseline_statement, baseline_period, user_quote, historical_evidence_ids, baseline_conflict)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [randomUUID(), runId, owner, comparison.subject, comparison.attribute, comparison.outcome, comparison.statement, JSON.stringify(comparison.evidenceIds), comparison.priorDimensions ? JSON.stringify(comparison.priorDimensions) : null, comparison.currentDimensions ? JSON.stringify(comparison.currentDimensions) : null, comparison.baselineOrigin, baselineStatement, comparison.baselinePeriod || null, comparison.userQuote || null, JSON.stringify(comparison.historicalEvidenceIds), comparison.baselineConflict || false]);
          if (comparison.outcome === 'prior_error') await tx.query(`INSERT INTO corrections (id, owner_id, source_message_id, comparison_run_id, correction)
            VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), owner, correctionTarget, runId, comparison.statement]);
        }
      }
      const seq = await tx.query<{ value: number }>('UPDATE owner_sequences SET value = value + 1 WHERE owner_id = $1 RETURNING value', [owner]);
      await tx.query("INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal) VALUES ($1, $2, $3, $4, 'assistant', $5, $6)", [randomUUID(), run.conversation_id, owner, run.turn_id, content, seq.rows[0].value]);
      await tx.query(`INSERT INTO indexing_jobs (id, message_id, owner_id, space_id, generation, status)
        SELECT md5(m.id || es.id || es.generation::text), m.id, m.owner_id, es.id, es.generation, 'pending'
        FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.owner_id = m.owner_id
        JOIN embedding_spaces es ON es.status IN ('active', 'building')
        WHERE m.turn_id = $1 AND m.role = 'user' AND c.deleted_at IS NULL AND c.recall_eligible = true
        ON CONFLICT (message_id, space_id, generation) DO NOTHING`, [run.turn_id]);
      await tx.query("UPDATE runs SET status = 'completed' WHERE id = $1", [runId]);
      await tx.query("UPDATE turns SET status = 'completed' WHERE id = $1", [run.turn_id]);
      await tx.query("UPDATE jobs SET status = 'completed' WHERE run_id = $1", [runId]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'completed', $2)", [runId, JSON.stringify({ content })]);
      return true;
    });
  }

  async publishIncomplete(owner: string, runId: string, content: string) {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string; conversation_id: string; status: string }>(`SELECT r.turn_id, r.conversation_id, r.status FROM runs r
        JOIN conversations c ON c.id = r.conversation_id AND c.owner_id = r.owner_id AND c.deleted_at IS NULL
        WHERE r.id = $1 AND r.owner_id = $2`, [runId, owner]);
      const run = result.rows[0];
      if (!run) throw new NotFound('Run not found');
      if (run.status !== 'active') return false;
      const revoked = await tx.query(`SELECT 1 FROM reference_snapshots rs JOIN reference_snapshot_items i ON i.snapshot_id = rs.id JOIN conversations sc ON sc.id = i.conversation_id
        WHERE rs.run_id = $1 AND rs.owner_id = $2 AND (rs.revoked = true OR sc.deleted_at IS NOT NULL OR (sc.id <> $3 AND sc.recall_eligible = false))
        UNION ALL SELECT 1 FROM history_snapshots hs JOIN history_snapshot_items i ON i.snapshot_id = hs.id JOIN conversations sc ON sc.id = i.conversation_id
        WHERE hs.run_id = $1 AND hs.owner_id = $2 AND (hs.revoked = true OR sc.deleted_at IS NOT NULL OR (sc.id <> $3 AND sc.recall_eligible = false)) LIMIT 1`, [runId, owner, run.conversation_id]);
      if (revoked.rows.length) throw new Conflict('Selected history is no longer eligible for reuse');
      const sequence = await tx.query<{ value: number }>('UPDATE owner_sequences SET value = value + 1 WHERE owner_id = $1 RETURNING value', [owner]);
      await tx.query("INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal) VALUES ($1, $2, $3, $4, 'assistant', $5, $6)", [randomUUID(), run.conversation_id, owner, run.turn_id, content, sequence.rows[0].value]);
      await tx.query("UPDATE runs SET status = 'incomplete' WHERE id = $1 AND owner_id = $2", [runId, owner]);
      await tx.query("UPDATE turns SET status = 'incomplete' WHERE id = $1", [run.turn_id]);
      await tx.query("UPDATE jobs SET status = 'incomplete' WHERE run_id = $1", [runId]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'incomplete', $2)", [runId, JSON.stringify({ content })]);
      return true;
    });
  }

  async cancel(owner: string, runId: string): Promise<string> {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string; status: string }>('SELECT turn_id, status FROM runs WHERE id = $1 AND owner_id = $2', [runId, owner]);
      const run = result.rows[0];
      if (!run) throw new NotFound('Run not found');
      if (run.status !== 'active') return run.status;
      await tx.query("UPDATE runs SET status = 'cancelled' WHERE id = $1 AND owner_id = $2", [runId, owner]);
      await tx.query("UPDATE turns SET status = 'cancelled' WHERE id = $1", [run.turn_id]);
      await tx.query("UPDATE jobs SET status = 'cancelled' WHERE run_id = $1", [runId]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'cancelled', '{}')", [runId]);
      return 'cancelled';
    });
  }

  async fail(owner: string, runId: string, message: string) {
    await this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string }>("UPDATE runs SET status = 'failed', error = $3 WHERE id = $1 AND owner_id = $2 AND status = 'active' RETURNING turn_id", [runId, owner, message]);
      if (!result.rows.length) return;
      await tx.query("UPDATE turns SET status = 'failed' WHERE id = $1", [result.rows[0].turn_id]);
      await tx.query("UPDATE jobs SET status = 'failed' WHERE run_id = $1", [runId]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'failed', $2)", [runId, JSON.stringify({ message })]);
    });
  }
}

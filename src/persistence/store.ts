import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';
import type { SearchResult } from '../search/tavily.js';

export class Conflict extends Error {}
export class NotFound extends Error {}

const payloadHash = (input: string, verifyCurrent = false) => createHash('sha256').update(JSON.stringify(verifyCurrent ? { input, verifyCurrent } : { input })).digest('hex');

type Run = { id: string; conversation_id: string; status: string; cutoff: number; error: string | null; created_at: Date; verify_current: boolean };
type Message = { id: string; role: string; content: string; ordinal: number; created_at: Date; citation_ids?: string[] };

export class Store {
  constructor(readonly db: PGlite) {}

  async initialize() {
    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
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
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, turn_id TEXT NOT NULL UNIQUE REFERENCES turns(id),
        conversation_id TEXT NOT NULL REFERENCES conversations(id), owner_id TEXT NOT NULL,
        status TEXT NOT NULL, cutoff INTEGER NOT NULL, error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE runs ADD COLUMN IF NOT EXISTS verify_current BOOLEAN NOT NULL DEFAULT false;
      CREATE TABLE IF NOT EXISTS jobs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), status TEXT NOT NULL
      );
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
      CREATE TABLE IF NOT EXISTS answer_claims (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), owner_id TEXT NOT NULL, claim TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claim_evidence (
        claim_id TEXT NOT NULL REFERENCES answer_claims(id), evidence_id TEXT NOT NULL REFERENCES evidence_observations(id),
        PRIMARY KEY (claim_id, evidence_id)
      );
      CREATE TABLE IF NOT EXISTS run_events (
        id SERIAL PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL, data TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async createConversation(owner: string) {
    const id = randomUUID();
    await this.db.query('INSERT INTO conversations (id, owner_id) VALUES ($1, $2)', [id, owner]);
    return id;
  }

  async listConversations(owner: string, limit = 50, offset = 0) {
    return (await this.db.query('SELECT id, created_at FROM conversations WHERE owner_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3', [owner, limit, offset])).rows;
  }

  async existingAdmission(owner: string, conversation: string, key: string, input: string, verifyCurrent = false) {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    const result = await this.db.query<{ id: string; payload_hash: string }>('SELECT runs.id, turns.payload_hash FROM turns JOIN runs ON runs.turn_id = turns.id WHERE turns.conversation_id = $1 AND turns.idempotency_key = $2', [conversation, key]);
    if (!result.rows.length) return null;
    if (result.rows[0].payload_hash !== payloadHash(input, verifyCurrent)) throw new Conflict('Idempotency key reused with different input');
    return result.rows[0].id;
  }

  async admit(owner: string, conversation: string, key: string, input: string, verifyCurrent = false) {
    const hash = payloadHash(input, verifyCurrent);
    return this.db.transaction(async tx => {
      const owned = await tx.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2', [conversation, owner]);
      if (!owned.rows.length) throw new NotFound('Conversation not found');
      const existing = await tx.query<{ id: string; payload_hash: string }>('SELECT runs.id, turns.payload_hash FROM turns JOIN runs ON runs.turn_id = turns.id WHERE turns.conversation_id = $1 AND turns.idempotency_key = $2', [conversation, key]);
      if (existing.rows.length) {
        if (existing.rows[0].payload_hash !== hash) throw new Conflict('Idempotency key reused with different input');
        return existing.rows[0].id;
      }
      const active = await tx.query("SELECT id FROM turns WHERE conversation_id = $1 AND status = 'active'", [conversation]);
      if (active.rows.length) throw new Conflict('Conversation already has an active turn');
      const turn = randomUUID(), run = randomUUID();
      const sequence = await tx.query<{ value: number }>(`INSERT INTO owner_sequences (owner_id, value) VALUES ($1, 1)
        ON CONFLICT (owner_id) DO UPDATE SET value = owner_sequences.value + 1 RETURNING value`, [owner]);
      const ordinal = sequence.rows[0].value;
      await tx.query("INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status) VALUES ($1, $2, $3, $4, $5, $6, 'active')", [turn, conversation, owner, key, hash, input]);
      await tx.query("INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal) VALUES ($1, $2, $3, $4, 'user', $5, $6)", [randomUUID(), conversation, owner, turn, input, ordinal]);
      await tx.query("INSERT INTO runs (id, turn_id, conversation_id, owner_id, status, cutoff, verify_current) VALUES ($1, $2, $3, $4, 'active', $5, $6)", [run, turn, conversation, owner, ordinal - 1, verifyCurrent]);
      await tx.query("INSERT INTO jobs (run_id, status) VALUES ($1, 'pending')", [run]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'accepted', '{}')", [run]);
      return run;
    });
  }

  async getRun(owner: string, id: string): Promise<Run> {
    const result = await this.db.query<Run>('SELECT id, conversation_id, status, cutoff, error, created_at, verify_current FROM runs WHERE id = $1 AND owner_id = $2', [id, owner]);
    if (!result.rows.length) throw new NotFound('Run not found');
    return result.rows[0];
  }

  async messages(owner: string, conversation: string, after = 0, limit = 50): Promise<Message[]> {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    return (await this.db.query<Message>(`SELECT m.id, m.role, m.content, m.ordinal, m.created_at, ARRAY(SELECT DISTINCT ce.evidence_id FROM runs r JOIN answer_claims ac ON ac.run_id = r.id JOIN claim_evidence ce ON ce.claim_id = ac.id WHERE r.turn_id = m.turn_id AND r.owner_id = m.owner_id AND m.role = 'assistant') AS citation_ids FROM messages m WHERE m.owner_id = $1 AND m.conversation_id = $2 AND m.ordinal > $3 ORDER BY m.ordinal LIMIT $4`, [owner, conversation, after, limit])).rows;
  }

  async context(owner: string, runId: string) {
    const run = await this.getRun(owner, runId);
    const current = await this.db.query<Message>(`SELECT m.id, m.role, m.content, m.ordinal, m.created_at
      FROM messages m JOIN runs r ON r.turn_id = m.turn_id
      WHERE r.id = $1 AND r.owner_id = $2 AND m.role = 'user'`, [runId, owner]);
    if (!current.rows.length) throw new NotFound('Run input not found');
    const history = await this.db.query<Message>(`SELECT * FROM (
      SELECT m.id, m.role, m.content, m.ordinal, m.created_at FROM messages m
      JOIN turns t ON t.id = m.turn_id
      WHERE m.owner_id = $1 AND m.conversation_id = $2 AND m.ordinal <= $3 AND t.status = 'completed'
      ORDER BY m.ordinal DESC LIMIT 200
      ) recent ORDER BY ordinal`, [owner, run.conversation_id, run.cutoff]);
    return { current: current.rows[0], history: history.rows };
  }

  async startSearch(owner: string, runId: string, query: string) {
    const id = randomUUID();
    const result = await this.db.query(`INSERT INTO search_queries (id, run_id, owner_id, query, status)
      SELECT $3, id, owner_id, $4, 'started' FROM runs WHERE id = $1 AND owner_id = $2 AND status = 'active' RETURNING id`, [runId, owner, id, query]);
    if (!result.rows.length) throw new NotFound('Active run not found');
    return id;
  }

  async finishSearch(owner: string, runId: string, id: string, status: 'completed' | 'failed') {
    await this.db.query(`UPDATE search_queries SET status = $4 WHERE id = $1 AND owner_id = $2 AND run_id = $3 AND status = 'started'`, [id, owner, runId, status]);
  }

  async recordProgress(owner: string, runId: string, stage: 'searching' | 'reviewing') {
    const result = await this.db.query(`INSERT INTO run_events (run_id, kind, data)
      SELECT id, 'progress', $3 FROM runs WHERE id = $1 AND owner_id = $2 AND status = 'active' RETURNING id`,
      [runId, owner, JSON.stringify({ stage })]);
    return result.rows.length > 0;
  }

  async registerEvidence(owner: string, runId: string, observations: SearchResult[], searchQueryId?: string) {
    return this.db.transaction(async tx => {
      const run = await tx.query<{ status: string }>('SELECT status FROM runs WHERE id = $1 AND owner_id = $2', [runId, owner]);
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
    const result = await this.db.query('SELECT id, run_id, url, title, excerpt, excerpt_hash, observed_at, provider, representation, search_query_id FROM evidence_observations WHERE id = $1 AND owner_id = $2', [id, owner]);
    if (!result.rows.length) throw new NotFound('Evidence not found');
    return result.rows[0];
  }

  async events(owner: string, id: string, after = 0) {
    await this.getRun(owner, id);
    return (await this.db.query<{ id: number; kind: string; data: string }>('SELECT id, kind, data FROM run_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 100', [id, after])).rows;
  }

  async publish(owner: string, runId: string, content: string, claims: { claim: string; evidenceIds: string[] }[] = []) {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string; conversation_id: string; status: string }>('SELECT turn_id, conversation_id, status FROM runs WHERE id = $1 AND owner_id = $2', [runId, owner]);
      const run = result.rows[0];
      if (!run) throw new NotFound('Run not found');
      if (run.status !== 'active') return false;
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
      const seq = await tx.query<{ value: number }>('UPDATE owner_sequences SET value = value + 1 WHERE owner_id = $1 RETURNING value', [owner]);
      await tx.query("INSERT INTO messages (id, conversation_id, owner_id, turn_id, role, content, ordinal) VALUES ($1, $2, $3, $4, 'assistant', $5, $6)", [randomUUID(), run.conversation_id, owner, run.turn_id, content, seq.rows[0].value]);
      await tx.query("UPDATE runs SET status = 'completed' WHERE id = $1", [runId]);
      await tx.query("UPDATE turns SET status = 'completed' WHERE id = $1", [run.turn_id]);
      await tx.query("UPDATE jobs SET status = 'completed' WHERE run_id = $1", [runId]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'completed', $2)", [runId, JSON.stringify({ content })]);
      return true;
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

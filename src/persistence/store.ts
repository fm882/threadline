import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';

export class Conflict extends Error {}
export class NotFound extends Error {}

type Run = { id: string; conversation_id: string; status: string; cutoff: number; error: string | null };
type Message = { id: string; role: string; content: string; ordinal: number; created_at: Date };

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
      CREATE TABLE IF NOT EXISTS jobs (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), status TEXT NOT NULL
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

  async admit(owner: string, conversation: string, key: string, input: string) {
    const hash = createHash('sha256').update(JSON.stringify({ input })).digest('hex');
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
      await tx.query("INSERT INTO runs (id, turn_id, conversation_id, owner_id, status, cutoff) VALUES ($1, $2, $3, $4, 'active', $5)", [run, turn, conversation, owner, ordinal - 1]);
      await tx.query("INSERT INTO jobs (run_id, status) VALUES ($1, 'pending')", [run]);
      await tx.query("INSERT INTO run_events (run_id, kind, data) VALUES ($1, 'accepted', '{}')", [run]);
      return run;
    });
  }

  async getRun(owner: string, id: string): Promise<Run> {
    const result = await this.db.query<Run>('SELECT id, conversation_id, status, cutoff, error FROM runs WHERE id = $1 AND owner_id = $2', [id, owner]);
    if (!result.rows.length) throw new NotFound('Run not found');
    return result.rows[0];
  }

  async messages(owner: string, conversation: string, after = 0, limit = 50): Promise<Message[]> {
    const owned = await this.db.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2', [conversation, owner]);
    if (!owned.rows.length) throw new NotFound('Conversation not found');
    return (await this.db.query<Message>('SELECT id, role, content, ordinal, created_at FROM messages WHERE owner_id = $1 AND conversation_id = $2 AND ordinal > $3 ORDER BY ordinal LIMIT $4', [owner, conversation, after, limit])).rows;
  }

  async events(owner: string, id: string, after = 0) {
    await this.getRun(owner, id);
    return (await this.db.query<{ id: number; kind: string; data: string }>('SELECT id, kind, data FROM run_events WHERE run_id = $1 AND id > $2 ORDER BY id LIMIT 100', [id, after])).rows;
  }

  async publish(owner: string, runId: string, content: string) {
    return this.db.transaction(async tx => {
      const result = await tx.query<{ turn_id: string; conversation_id: string; status: string }>('SELECT turn_id, conversation_id, status FROM runs WHERE id = $1 AND owner_id = $2', [runId, owner]);
      const run = result.rows[0];
      if (!run) throw new NotFound('Run not found');
      if (run.status !== 'active') return false;
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

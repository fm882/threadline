import { PGlite } from '@electric-sql/pglite';
import { createHash, randomUUID } from 'node:crypto';

export class Conflict extends Error {}
export class NotFound extends Error {}

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
    `);
  }

  async createConversation(owner: string) {
    const id = randomUUID();
    await this.db.query('INSERT INTO conversations (id, owner_id) VALUES ($1, $2)', [id, owner]);
    return id;
  }

  async admit(owner: string, conversation: string, key: string, input: string) {
    const hash = createHash('sha256').update(JSON.stringify({ input })).digest('hex');
    return this.db.transaction(async tx => {
      const owned = await tx.query('SELECT id FROM conversations WHERE id = $1 AND owner_id = $2', [conversation, owner]);
      if (!owned.rows.length) throw new NotFound('Conversation not found');
      const existing = await tx.query<{ id: string; payload_hash: string }>('SELECT id, payload_hash FROM turns WHERE conversation_id = $1 AND idempotency_key = $2', [conversation, key]);
      if (existing.rows.length) {
        if (existing.rows[0].payload_hash !== hash) throw new Conflict('Idempotency key reused with different input');
        return existing.rows[0].id;
      }
      const active = await tx.query("SELECT id FROM turns WHERE conversation_id = $1 AND status = 'active'", [conversation]);
      if (active.rows.length) throw new Conflict('Conversation already has an active turn');
      const id = randomUUID();
      await tx.query("INSERT INTO turns (id, conversation_id, owner_id, idempotency_key, payload_hash, input, status) VALUES ($1, $2, $3, $4, $5, $6, 'active')", [id, conversation, owner, key, hash, input]);
      return id;
    });
  }
}

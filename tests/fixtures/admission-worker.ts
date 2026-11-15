import { PGlite } from '@electric-sql/pglite';
import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';

const db = new PGlite(join(process.env.APP_DATA_DIR!, 'app-db'));
const store = new Store(db); await store.initialize();
const conversation = await store.createConversation('local-development-user');
const runId = await store.admit('local-development-user', conversation, 'key', 'question');
console.log(JSON.stringify({ conversation, runId }));
await new Promise(() => {});

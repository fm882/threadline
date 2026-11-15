import { PGlite } from '@electric-sql/pglite';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { join } from 'node:path';
import { Store } from '../../src/persistence/store.js';
import { createChatRunner } from '../../src/research/chat.js';

const dir = process.env.APP_DATA_DIR!;
const db = new PGlite(join(dir, 'app-db'));
const store = new Store(db); await store.initialize();
const saver = SqliteSaver.fromConnString(join(dir, 'checkpoints.sqlite'));
store.publish = async () => {
  console.log('CHECKPOINT_READY');
  return new Promise<boolean>(() => {});
};
await createChatRunner(store, saver, async () => 'checkpointed response')('alice', process.env.TEST_RUN_ID!);

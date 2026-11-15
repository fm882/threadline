import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { EventEmitter } from 'node:events';
import { Conflict, NotFound, Store } from '../persistence/store.js';
import { MAX_INPUT_CHARS } from '../research/chat.js';
import { createDispatcher, type Dispatcher, type RunWorker } from '../jobs/dispatcher.js';

export const chunks = new EventEmitter();
chunks.setMaxListeners(0);
const bodySchema = z.object({ input: z.string().min(1).max(MAX_INPUT_CHARS).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= 16_000), verifyCurrent: z.boolean().default(false) }).strict();
const timezoneSchema = z.object({ timezone: z.string().min(1).max(100).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }), initialize: z.boolean().default(false), fallback: z.boolean().default(false) }).strict().refine(value => !value.fallback || (value.initialize && value.timezone === 'UTC'));
const cursorSchema = z.coerce.number().int().min(0).max(2_147_483_647).default(0);

export function createApp(options: { store: Store; owner: (request: Request) => string; ready: () => string | null | Promise<string | null>; run: RunWorker; dispatcher?: Dispatcher }) {
  const { store, owner, ready, run } = options;
  const dispatcher = options.dispatcher || createDispatcher(store, run);
  const app = new Hono();
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (host && !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return c.json({ error: 'Invalid host' }, 403);
    const origin = c.req.header('origin');
    if (origin) {
      const parsed = URL.parse(origin);
      if (!parsed || parsed.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(parsed.hostname) || !['3000', '5173'].includes(parsed.port)) return c.json({ error: 'Invalid origin' }, 403);
    }
    await next();
  });
  app.use('/api/*', bodyLimit({ maxSize: 32_768, onError: c => c.json({ error: 'Request too large' }, 413) }));
  app.onError((error, c) => {
    if (error instanceof NotFound) return c.json({ error: error.message }, 404);
    if (error instanceof Conflict) return c.json({ error: error.message }, 409);
    return c.json({ error: 'Internal service error' }, 500);
  });
  app.get('/health/live', c => c.json({ status: 'live' }));
  app.get('/health/ready', async c => {
    const problem = await ready();
    return problem ? c.json({ status: 'unavailable', error: problem }, 503) : c.json({ status: 'ready' });
  });
  app.post('/api/conversations', async c => c.json({ id: await store.createConversation(owner(c.req.raw)) }, 201));
  app.get('/api/conversations', async c => {
    const offset = cursorSchema.safeParse(c.req.query('offset'));
    if (!offset.success) return c.json({ error: 'Invalid offset' }, 400);
    return c.json({ conversations: await store.listConversations(owner(c.req.raw), 50, offset.data) });
  });
  app.patch('/api/conversations/:id', async c => {
    const parsed = timezoneSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Provide a valid IANA timezone.' }, 400);
    const { timezone, initialize, fallback } = parsed.data;
    return c.json(await store.setTimezone(owner(c.req.raw), c.req.param('id'), timezone, initialize ? (fallback ? 'fallback' : 'browser') : 'user', initialize));
  });
  app.get('/api/conversations/:id/active-run', async c => c.json({ runId: await store.activeRun(owner(c.req.raw), c.req.param('id')) }));
  app.get('/api/conversations/:id/messages', async c => {
    const after = cursorSchema.safeParse(c.req.query('after'));
    if (!after.success) return c.json({ error: 'Invalid cursor' }, 400);
    return c.json({ messages: await store.messages(owner(c.req.raw), c.req.param('id'), after.data) });
  });
  app.post('/api/conversations/:id/turns', async c => {
    const key = c.req.header('Idempotency-Key');
    if (!key || key.length > 200) return c.json({ error: 'A valid Idempotency-Key is required' }, 400);
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Input must be nonempty, at most 8000 characters and at most 16000 UTF-8 bytes' }, 400);
    const identity = owner(c.req.raw);
    const existing = await store.existingAdmission(identity, c.req.param('id'), key, parsed.data.input, parsed.data.verifyCurrent);
    if (existing) return c.json({ runId: existing }, 202);
    const problem = await ready();
    if (problem) return c.json({ error: problem }, 503);
    const id = await store.admit(identity, c.req.param('id'), key, parsed.data.input, parsed.data.verifyCurrent);
    dispatcher.dispatch(identity, id);
    return c.json({ runId: id }, 202);
  });
  app.get('/api/evidence/:id', async c => c.json(await store.evidence(owner(c.req.raw), c.req.param('id'))));
  app.get('/api/history/:id', async c => {
    const after = cursorSchema.safeParse(c.req.query('after'));
    if (!after.success) return c.json({ error: 'Invalid cursor' }, 400);
    try { return c.json(await store.dateRecallSnapshot(owner(c.req.raw), c.req.param('id'), after.data)); }
    catch (error) {
      if (error instanceof Error && error.message === 'Invalid pagination cursor') return c.json({ error: 'Invalid cursor' }, 400);
      throw error;
    }
  });
  app.post('/api/runs/:id/cancel', async c => {
    const id = c.req.param('id');
    const status = await store.cancel(owner(c.req.raw), id);
    if (status === 'cancelled') dispatcher.abort(id);
    return c.json({ status });
  });
  app.get('/api/runs/:id', async c => c.json(await store.getRun(owner(c.req.raw), c.req.param('id'))));
  app.get('/api/runs/:id/events', async c => {
    const identity = owner(c.req.raw), id = c.req.param('id');
    const cursor = cursorSchema.safeParse(c.req.header('Last-Event-ID') ?? c.req.query('after'));
    if (!cursor.success) return c.json({ error: 'Invalid cursor' }, 400);
    const checkpoint = await store.eventCursor(identity, id, cursor.data);
    return streamSSE(c, async stream => {
      let last = checkpoint.valid ? cursor.data : 0;
      let terminalSeen = ['completed', 'failed', 'cancelled'].includes(checkpoint.kind || '');
      const pending: string[] = [];
      let pendingBytes = 0;
      const listener = (part: string) => {
        const size = Buffer.byteLength(part);
        if (pending.length < 128 && pendingBytes + size <= 32_768) { pending.push(part); pendingBytes += size; }
      };
      const drain = async () => {
        while (pending.length) {
          const part = pending.shift()!; pendingBytes -= Buffer.byteLength(part);
          await stream.writeSSE({ event: 'delta', data: JSON.stringify({ content: part }) });
        }
      };
      chunks.on(id, listener);
      try {
        if (!checkpoint.valid) await stream.writeSSE({ event: 'reset', data: JSON.stringify({ reason: 'cursor_unavailable' }) });
        while (!stream.aborted) {
          const events = await store.events(identity, id, last);
          for (const event of events) {
            if (event.kind === 'completed' || event.kind === 'failed' || event.kind === 'cancelled') {
              terminalSeen = true;
              chunks.off(id, listener);
              await drain();
            }
            last = event.id;
            await stream.writeSSE({ id: String(event.id), event: event.kind, data: event.data });
          }
          await drain();
          const state = await store.getRun(identity, id);
          // Publication may commit between reading events and reading state. Recheck
          // the durable log before closing so the terminal event is never skipped.
          if (state.status !== 'active' && events.length < 100 && (await store.events(identity, id, last)).length === 0) {
            if (!terminalSeen) {
              const snapshot = await store.terminalSnapshot(identity, id);
              if (snapshot) await stream.writeSSE({ event: snapshot.kind, data: snapshot.data });
            }
            break;
          }
          await stream.sleep(250);
        }
      } finally { chunks.off(id, listener); }
    });
  });
  return app;
}

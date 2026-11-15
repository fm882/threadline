import { it, expect } from 'vitest';
import { createServer } from 'node:http';
import { gatewayClient } from '../src/research/chat.js';

it('uses the OpenAI-compatible gateway streaming contract with the configured model', async () => {
  let request: any;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    request = JSON.parse(body);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ id: 'chatcmpl-test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    const client = gatewayClient(`http://127.0.0.1:${address.port}/v1`, 'test-key', 'chat-main-v1');
    const chunks: string[] = [];
    expect(await client([{ role: 'user', content: 'Hi' }], chunk => chunks.push(chunk), AbortSignal.timeout(5000))).toBe('Hello');
    expect(chunks.join('')).toBe('Hello');
    expect(request.model).toBe('chat-main-v1');
    expect(request.stream).toBe(true);
    expect(request.max_tokens).toBe(1024);
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});

it('does not follow gateway redirects with conversation content or credentials', async () => {
  let redirected = false;
  const target = createServer((_req, res) => { redirected = true; res.end(); });
  await new Promise<void>(resolve => target.listen(0, '127.0.0.1', resolve));
  const address = target.address();
  if (!address || typeof address === 'string') throw new Error('Missing listener');
  const gateway = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${address.port}/capture` }); res.end(); });
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  try {
    const gatewayAddress = gateway.address();
    if (!gatewayAddress || typeof gatewayAddress === 'string') throw new Error('Missing listener');
    const client = gatewayClient(`http://127.0.0.1:${gatewayAddress.port}/v1`, 'secret', 'chat-main-v1');
    await expect(client([{ role: 'user', content: 'private' }], () => {}, AbortSignal.timeout(5000))).rejects.toThrow();
    expect(redirected).toBe(false);
  } finally {
    await Promise.all([new Promise<void>(resolve => gateway.close(() => resolve())), new Promise<void>(resolve => target.close(() => resolve()))]);
  }
});

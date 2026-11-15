import { it, expect } from 'vitest';
import { gatewayConfig, gatewayReadiness } from '../src/inference/readiness.js';

it('rejects unsafe endpoints and does not send local gateway keys remotely', () => {
  expect(gatewayConfig({ INFERENCE_BASE_URL: 'http://example.com/v1', LITELLM_MASTER_KEY: 'local' }).error).toContain('HTTPS');
  const remote = gatewayConfig({ INFERENCE_BASE_URL: 'https://example.com/v1', LITELLM_MASTER_KEY: 'local' });
  expect(remote.key).toBe('');
  expect(remote.error).toContain('INFERENCE_API_KEY');
  expect(gatewayConfig({ LITELLM_MASTER_KEY: 'local' }).key).toBe('local');
});

it('checks gateway availability and the configured model without exposing provider errors', async () => {
  const config = gatewayConfig({ INFERENCE_API_KEY: 'secret' });
  expect(await gatewayReadiness(config, async () => Response.json({ data: [{ id: 'chat-main-v1' }] }))()).toBeNull();
  expect(await gatewayReadiness(config, async () => Response.json({ data: [] }))()).toContain('model');
  expect(await gatewayReadiness(config, async () => { throw new Error('secret'); })()).not.toContain('secret');
  expect(await gatewayReadiness(config, async () => new Response('secret', { status: 401 }))()).toContain('credentials');
});

it('detects a local gateway key created after the application starts', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'minmi-key-'));
  try {
    const keyPath = join(dir, 'gateway.key');
    const read = () => gatewayConfig({}, keyPath);
    expect(read().error).toContain('gateway');
    await writeFile(keyPath, 'new-local-key');
    let authorization = '';
    const request: typeof fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('Authorization') || '';
      return Response.json({ data: [{ id: 'chat-main-v1' }] });
    };
    expect(await gatewayReadiness(read(), request)()).toBeNull();
    expect(authorization).toBe('Bearer new-local-key');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('reports an unreadable local key as a safe configuration failure', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'minmi-key-error-'));
  try {
    // Reading a directory as a file fails reliably without relying on user permissions.
    const config = gatewayConfig({}, dir);
    expect(config.error).toContain('Cannot read the local gateway key');
    expect(await gatewayReadiness(config)()).toBe(config.error);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

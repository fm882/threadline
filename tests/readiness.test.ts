import { it, expect } from 'vitest';
import { gatewayConfig, gatewayReadiness } from '../src/inference/readiness.js';

const fallbackRoute = 'bedrock/converse/us.amazon.nova-micro-v1:0';

it('rejects unsafe endpoints and does not send local gateway keys remotely', () => {
  expect(gatewayConfig({ INFERENCE_BASE_URL: 'http://example.com/v1', LITELLM_MASTER_KEY: 'local', BEDROCK_FAST_ROUTE: fallbackRoute }).error).toContain('HTTPS');
  const remote = gatewayConfig({ INFERENCE_BASE_URL: 'https://example.com/v1', LITELLM_MASTER_KEY: 'local', BEDROCK_FAST_ROUTE: fallbackRoute });
  expect(remote.key).toBe('');
  expect(remote.error).toContain('INFERENCE_API_KEY');
  expect(gatewayConfig({ LITELLM_MASTER_KEY: 'local', BEDROCK_FAST_ROUTE: fallbackRoute }).key).toBe('local');
});

it('checks gateway availability and the configured model without exposing provider errors', async () => {
  const config = gatewayConfig({ INFERENCE_API_KEY: 'secret', BEDROCK_FAST_ROUTE: fallbackRoute });
  expect(await gatewayReadiness(config, async () => Response.json({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] }))()).toBeNull();
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
    const read = () => gatewayConfig({ BEDROCK_FAST_ROUTE: fallbackRoute }, keyPath);
    expect(read().error).toContain('gateway');
    await writeFile(keyPath, 'new-local-key');
    let authorization = '';
    const request: typeof fetch = async (_url, init) => {
      authorization = new Headers(init?.headers).get('Authorization') || '';
      return Response.json({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] });
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
    const config = gatewayConfig({ BEDROCK_FAST_ROUTE: fallbackRoute }, dir);
    expect(config.error).toContain('Cannot read the local gateway key');
    expect(await gatewayReadiness(config)()).toBe(config.error);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('requires an attested fallback route to be advertised before readiness', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'minmi-readiness-'));
  const path = join(dir, 'manifest.json');
  await writeFile(path, JSON.stringify({
    version: 'fixture-v1',
    chatMain: { model: 'chat-main-v1', streaming: true, contextTokens: 32_000, maxOutputTokens: 4096 },
    chatFallback: {
      model: 'chat-fast-v1', streaming: true, toolCalls: true, promptedJson: true,
      contextTokens: 16_000, maxOutputTokens: 1024,
      verification: { streaming: 'passed', researchContract: 'passed', backendRoute: 'bedrock/converse/us.amazon.nova-micro-v1:0', checkedAt: '2026-11-16T00:00:00.000Z' },
    },
  }));
  try {
    const config = gatewayConfig({ INFERENCE_API_KEY: 'secret', MODEL_CAPABILITIES_PATH: path, BEDROCK_FAST_ROUTE: 'bedrock/converse/us.amazon.nova-micro-v1:0' });
    expect(await gatewayReadiness(config, async () => Response.json({ data: [{ id: 'chat-main-v1' }] }))()).toContain('fallback model');
    expect(await gatewayReadiness(config, async () => Response.json({ data: [{ id: 'chat-main-v1' }, { id: 'chat-fast-v1' }] }))()).toBeNull();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

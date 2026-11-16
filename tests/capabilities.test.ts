import { it, expect } from 'vitest';
import { loadCapabilities } from '../src/inference/capabilities.js';

it('requires the configured streaming model to match the capability manifest', () => {
  expect(loadCapabilities('config/model-capabilities.json', 'chat-main-v1', 'chat-fast-v1', 'bedrock/converse/us.amazon.nova-micro-v1:0')).toHaveProperty('manifest');
  expect(loadCapabilities('config/model-capabilities.json', 'other')).toHaveProperty('error');
  expect(loadCapabilities('missing.json', 'chat-main-v1')).toHaveProperty('error');
});

it('permits only an attested, separate, smaller-context research fallback', async () => {
  const { mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'minmi-capabilities-'));
  const path = join(dir, 'manifest.json');
  const backendRoute = 'bedrock/converse/us.amazon.nova-micro-v1:0';
  const manifest = {
    version: 'fixture-v1',
    chatMain: { model: 'chat-main-v1', streaming: true, contextTokens: 32_000, maxOutputTokens: 8192 },
    chatFallback: {
      model: 'chat-fast-v1', streaming: true, toolCalls: true, promptedJson: true,
      contextTokens: 16_000, maxOutputTokens: 1024,
      verification: { streaming: 'passed', researchContract: 'passed', backendRoute, checkedAt: '2026-11-16T00:00:00.000Z' },
    },
  };
  try {
    await writeFile(path, JSON.stringify(manifest));
    expect(loadCapabilities(path, 'chat-main-v1', 'chat-fast-v1', backendRoute)).toMatchObject({ fallback: { model: 'chat-fast-v1', contextTokens: 16_000 } });
    for (const invalid of [
      { ...manifest.chatFallback, toolCalls: false },
      { ...manifest.chatFallback, promptedJson: false },
      { ...manifest.chatFallback, contextTokens: 32_000 },
      { ...manifest.chatFallback, model: 'chat-main-v1' },
      { ...manifest.chatFallback, verification: { ...manifest.chatFallback.verification, researchContract: 'missing' } },
    ]) {
      await writeFile(path, JSON.stringify({ ...manifest, chatFallback: invalid }));
      expect(loadCapabilities(path, 'chat-main-v1', 'chat-fast-v1', backendRoute)).toHaveProperty('error');
    }
    await writeFile(path, JSON.stringify(manifest));
    expect(loadCapabilities(path, 'chat-main-v1', 'other-fast-alias', backendRoute)).toHaveProperty('error');
    expect(loadCapabilities(path, 'chat-main-v1', 'chat-fast-v1', 'bedrock/converse/unverified-route')).toHaveProperty('error');
    expect(loadCapabilities(path, 'chat-main-v1', 'chat-fast-v1')).toHaveProperty('error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

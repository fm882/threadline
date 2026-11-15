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

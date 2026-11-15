import { it, expect } from 'vitest';
import { loadCapabilities } from '../src/inference/capabilities.js';

it('requires the configured streaming model to match the capability manifest', () => {
  expect(loadCapabilities('config/model-capabilities.json', 'chat-main-v1')).toHaveProperty('manifest');
  expect(loadCapabilities('config/model-capabilities.json', 'other')).toHaveProperty('error');
  expect(loadCapabilities('missing.json', 'chat-main-v1')).toHaveProperty('error');
});

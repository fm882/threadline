import { existsSync, readFileSync } from 'node:fs';
import { loadCapabilities } from './capabilities.js';

export function gatewayConfig(env: NodeJS.ProcessEnv, keyPath = '.data/litellm.key') {
  const base = env.INFERENCE_BASE_URL || 'http://127.0.0.1:4000/v1';
  const url = URL.parse(base);
  const model = env.CHAT_MAIN_MODEL || 'chat-main-v1';
  const capabilities = loadCapabilities(env.MODEL_CAPABILITIES_PATH || 'config/model-capabilities.json', model);
  const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  let key = env.INFERENCE_API_KEY || '';
  let keyError: string | null = null;
  if (!key && local) {
    try {
      key = env.LITELLM_MASTER_KEY || (existsSync(keyPath) ? readFileSync(keyPath, 'utf8').trim() : '');
    } catch {
      keyError = 'Cannot read the local gateway key. Check its permissions and restart the gateway if needed.';
    }
  }
  const error = 'error' in capabilities ? capabilities.error ?? 'Invalid capability manifest.'
    : !url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
      ? 'Set a valid INFERENCE_BASE_URL without credentials or query parameters.'
      : !local && url.protocol !== 'https:' ? 'Remote inference requires an HTTPS endpoint.'
      : keyError || (!key ? 'Start the local gateway or set INFERENCE_API_KEY.' : null);
  return { base: base.replace(/\/$/, ''), key, model, error };
}

export function gatewayReadiness(config: ReturnType<typeof gatewayConfig>, request: typeof fetch = fetch) {
  return async (): Promise<string | null> => {
    if (config.error) return config.error;
    try {
      const response = await request(`${config.base}/models`, {
        headers: { Authorization: `Bearer ${config.key}` }, signal: AbortSignal.timeout(2000), redirect: 'error',
      });
      if (!response.ok) return 'Gateway is unavailable or rejected its credentials. Check gateway configuration.';
      const data: unknown = await response.json();
      if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data) ||
          !data.data.some((item: unknown) => typeof item === 'object' && item !== null && 'id' in item && item.id === config.model)) {
        return 'Gateway does not advertise the configured chat model. Check the model route.';
      }
      return null;
    } catch {
      return 'Gateway is unavailable. Start the gateway and check INFERENCE_BASE_URL.';
    }
  };
}

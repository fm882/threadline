import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
const envPath = join(root, '.env');
if (existsSync(envPath)) process.loadEnvFile(envPath);

export function localKey() {
  if (process.env.INFERENCE_API_KEY) return process.env.INFERENCE_API_KEY;
  if (process.env.LITELLM_MASTER_KEY) return process.env.LITELLM_MASTER_KEY;
  const keyPath = join(root, '.data', 'litellm.key');
  if (existsSync(keyPath)) return readFileSync(keyPath, 'utf8').trim();
  throw new Error('Start the local gateway first, or configure INFERENCE_API_KEY.');
}

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './local-env.mjs';

const env = { ...process.env };
env.TOKENHARBOR_API_KEY ||= env.token_harbor_api;
if (!env.TOKENHARBOR_API_KEY) throw new Error('Set TOKENHARBOR_API_KEY in .env to route the main chat alias through Token Harbor.');
env.AWS_REGION_NAME ||= env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
env.AWS_DEFAULT_REGION ||= env.AWS_REGION_NAME;
env.BEDROCK_FAST_ROUTE ||= 'bedrock/converse/us.amazon.nova-micro-v1:0';
env.BEDROCK_EMBEDDING_ROUTE ||= 'bedrock/amazon.titan-embed-text-v2:0';
env.BEDROCK_RERANK_REGION ||= env.AWS_REGION_NAME;
env.BEDROCK_RERANK_ROUTE ||= `bedrock/arn:aws:bedrock:${env.BEDROCK_RERANK_REGION}::foundation-model/cohere.rerank-v3-5:0`;

const port = Number(env.LITELLM_PORT || 4000);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error('LITELLM_PORT must be an integer between 1024 and 65535.');
}
const dataDir = join(root, '.data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const keyPath = join(dataDir, 'litellm.key');
if (!env.LITELLM_MASTER_KEY) {
  if (!existsSync(keyPath)) {
    writeFileSync(keyPath, `sk-${randomBytes(32).toString('hex')}\n`, { mode: 0o600, flag: 'wx' });
  }
  env.LITELLM_MASTER_KEY = readFileSync(keyPath, 'utf8').trim();
}
if (!env.LITELLM_MASTER_KEY.startsWith('sk-') || env.LITELLM_MASTER_KEY.length < 24) {
  throw new Error('Use a randomly generated local key beginning with sk- (at least 24 characters).');
}

console.log(`Starting loopback-only LiteLLM on http://127.0.0.1:${port}; region ${env.AWS_REGION_NAME}.`);
console.log('Uses configured Token Harbor and AWS credentials. Keys are never printed. Ctrl-C stops the gateway.');
const child = spawn(env.LITELLM_BIN || 'litellm', [
  '--config', join(root, 'infra/litellm/config.yaml'),
  '--host', '127.0.0.1', '--port', String(port),
], { cwd: root, env, stdio: 'inherit', detached: process.platform !== 'win32' });
child.on('error', (error) => {
  console.error(`Cannot start LiteLLM: ${error.code || 'launch error'}. See infra/litellm/README.md.`);
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
});
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 0 : 1); });

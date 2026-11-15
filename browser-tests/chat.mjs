import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const live = process.env.MINMI_LIVE_BROWSER === '1';
const cancel = process.env.MINMI_TEST_CANCEL === '1';
const dir = await mkdtemp(join(tmpdir(), 'minmi-browser-'));
const gateway = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }] })); return; }
  for await (const _ of req) { /* consume */ }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = content => JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  res.write(`data: ${chunk('Browser ')}\n\n`);
  setTimeout(() => res.end(`data: ${chunk('answer')}\n\ndata: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), cancel ? 5000 : 300);
});
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
const port = gateway.address().port;
let child, browser;
const base = 'http://127.0.0.1:5173';
function start() { return spawn('npm', ['run', 'dev'], { stdio: 'ignore', env: { ...process.env, APP_DATA_DIR: dir, ...(live ? {} : { INFERENCE_BASE_URL: `http://127.0.0.1:${port}/v1`, INFERENCE_API_KEY: 'fixture' }), LANGSMITH_TRACING: 'false' }, detached: true }); }
async function stop() { if (!child || child.exitCode !== null) return; const done = once(child, 'exit'); process.kill(-child.pid, 'SIGTERM'); await done; }
async function waitReady() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health/ready`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('App did not become ready'); }
try {
  child = start(); await waitReady();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.goto(base);
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill(live ? 'Reply exactly: Browser answer' : 'Browser question');
  await page.getByRole('button', { name: 'Send' }).click();
  if (cancel) {
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.getByText('Run stopped.').waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('Browser answer', { exact: true }).count(), 0);
    console.log('Browser cancellation passed with a synthetic gateway.');
  } else {
  await page.locator('article.assistant .content').first().waitFor({ timeout: 70000 });
  await page.waitForFunction(() => !document.querySelector('#message')?.disabled, null, { timeout: 70000 });
  assert.equal(await page.getByText(live ? 'Reply exactly: Browser answer' : 'Browser question', { exact: true }).count(), 1);
  const answer = await page.locator('article.assistant .content').first().innerText();
  assert.ok(answer.trim());
  if (!live) assert.equal(answer, 'Browser answer');
  await stop(); child = start(); await waitReady();
  await page.reload();
  await page.getByRole('button', { name: /Conversation 1/ }).click();
  await page.locator('article.assistant .content').first().waitFor();
  assert.equal(await page.locator('article.assistant .content').first().innerText(), answer);
  assert.equal(await page.getByText(live ? 'Reply exactly: Browser answer' : 'Browser question', { exact: true }).count(), 1);
  console.log(`Browser chat and restart passed with ${live ? 'the configured live' : 'a synthetic'} gateway.`);
  }
} finally {
  if (browser) await browser.close();
  await stop();
  await new Promise(resolve => gateway.close(resolve));
  await rm(dir, { recursive: true, force: true });
}

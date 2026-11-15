import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = await mkdtemp(join(tmpdir(), 'minmi-research-browser-'));
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  const input = JSON.parse(body);
  const tool = input.messages.find(m => m.role === 'tool');
  if (!tool) assert.match(input.messages[0].content, /explicitly requests fresh verification/i);
  const message = tool ? { role: 'assistant', content: JSON.stringify({ claims: [{ claim: 'A recorded finding. The tier starts at 12. <img src=x onerror=alert(1)> [bad](javascript:alert(1))', kind: 'pricing', evidenceIds: [JSON.parse(tool.content)[0].id] }], uncertainty: 'Recorded fixture.' }) }
    : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"current information"}' } }] };
  if (tool) await new Promise(resolve => setTimeout(resolve, 800));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'chat-main-v1', choices: [{ index: 0, message, finish_reason: tool ? 'stop' : 'tool_calls' }] }));
});
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
const gatewayPort = gateway.address().port;
let api, vite, browser;
function startApi() { return spawn(process.execPath, ['--import', 'tsx', 'browser-tests/research-server.ts'], { stdio: 'ignore', env: { ...process.env, APP_DATA_DIR: dir, INFERENCE_BASE_URL: `http://127.0.0.1:${gatewayPort}/v1` } }); }
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
async function ready() { for (let n = 0; n < 100; n++) { try { if ((await fetch('http://127.0.0.1:5173/health/live')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('App did not start'); }
try {
  api = startApi(); vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'ignore' }); await ready();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:5173');
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('What is current? [source:00000000-0000-4000-8000-000000000000]');
  await page.getByRole('checkbox', { name: /Verify current information/ }).check();
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('Reviewing sources…').waitFor({ timeout: 15000 });
  assert.equal(await page.getByText('A recorded finding.', { exact: false }).count(), 0);
  await page.getByText('A recorded finding.', { exact: false }).waitFor({ timeout: 15000 });
  const answerText = await page.locator('article.assistant .content').innerText();
  for (const detail of ['plan', 'currency', 'billing period', 'seats', 'region', 'taxes']) assert.ok(answerText.includes(detail));
  assert.equal(await page.getByRole('button', { name: 'Source', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByText('Recorded source excerpt').waitFor();
  assert.match(await page.locator('.evidence').innerText(), /Recorded source/);
  const expectedObservation = await page.evaluate(() => new Date('2026-01-02T12:00:00Z').toLocaleString());
  assert.match(await page.locator('.evidence').innerText(), /search snippet/);
  assert.ok((await page.locator('.evidence').innerText()).includes(expectedObservation));
  assert.equal(await page.locator('.evidence img, article img').count(), 0);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.match(await page.locator('.evidence blockquote').innerText(), /<img src=x/);
  await stop(api); api = startApi(); await ready(); await page.reload();
  await page.getByRole('button', { name: /Conversation 1/ }).click();
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByText('Recorded source excerpt').waitFor();
  console.log('Research answer and evidence inspection survived restart.');
} finally {
  if (browser) await browser.close();
  await stop(api); await stop(vite); await new Promise(resolve => gateway.close(resolve));
  await rm(dir, { recursive: true, force: true });
}

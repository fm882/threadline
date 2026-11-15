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
const replace = process.env.MINMI_TEST_REPLACE === '1';
const reconnect = process.env.MINMI_TEST_RECONNECT === '1';
const timezoneTest = process.env.MINMI_TEST_TIMEZONE === '1';
const timezoneFallbackTest = process.env.MINMI_TEST_UTC_FALLBACK === '1';
const stopRace = process.env.MINMI_TEST_STOP_RACE === '1';
const referenceTest = process.env.MINMI_TEST_REFERENCE === '1';
const originalQuestion = process.env.MINMI_TEST_RECALL === '1' ? 'Browser question about yesterday?' : referenceTest ? 'We shortlisted five CRM tools for a 20-person sales team.' : 'Browser question';
let requestCount = 0;
const dir = await mkdtemp(join(tmpdir(), 'minmi-browser-'));
const gateway = createServer(async (req, res) => {
  if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'chat-main-v1' }] })); return; }
  for await (const _ of req) { /* consume */ }
  requestCount++;
  const thisRequest = requestCount;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  const chunk = content => JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
  res.write(`data: ${chunk(replace && thisRequest > 1 ? 'Replacement ' : 'Browser ')}\n\n`);
  setTimeout(() => res.end(`data: ${chunk('answer')}\n\ndata: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'chat-main-v1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`), cancel || reconnect || (replace && thisRequest === 1) ? 5000 : 300);
});
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
const port = gateway.address().port;
let child, browser;
const base = 'http://127.0.0.1:5173';
function start() { return spawn('npm', ['run', 'dev'], { stdio: 'ignore', env: { ...process.env, PORT: process.env.PORT || '3457', APP_DATA_DIR: dir, ...(live ? {} : { INFERENCE_BASE_URL: `http://127.0.0.1:${port}/v1`, INFERENCE_API_KEY: 'fixture' }), LANGSMITH_TRACING: 'false' }, detached: true }); }
async function stop() {
  if (!child) return;
  const done = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await done;
  child = null;
}
async function waitReady() { for (let i = 0; i < 100; i++) { try { if ((await fetch(`${base}/health/ready`)).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('App did not become ready'); }
try {
  child = start(); await waitReady();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage(timezoneTest ? { timezoneId: 'Asia/Kolkata' } : {});
  if (timezoneFallbackTest) await page.addInitScript(() => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    Intl.DateTimeFormat.prototype.resolvedOptions = function () { return { ...original.call(this), timeZone: undefined }; };
  });
  if (stopRace) await page.route('**/api/runs/*/cancel', async route => { await new Promise(resolve => setTimeout(resolve, 1000)); await route.continue(); });
  await page.goto(base);
  await page.getByRole('button', { name: '+ New conversation' }).click();
  if (timezoneFallbackTest) await page.getByText('UTC fallback: browser timezone unavailable.').waitFor();
  if (timezoneTest) {
    await page.waitForFunction(() => document.querySelector('#timezone')?.value === 'Asia/Calcutta' || document.querySelector('#timezone')?.value === 'Asia/Kolkata');
    await page.getByLabel('Timezone').fill('America/New_York');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Timezone saved for future turns.').waitFor();
    await page.reload();
    await page.getByRole('button', { name: /Conversation 1/ }).click();
    await page.waitForFunction(() => document.querySelector('#timezone')?.value === 'America/New_York');
  }
  await page.getByLabel('Your message').fill(live ? 'Reply exactly: Browser answer' : originalQuestion);
  const admission = page.waitForResponse(response => response.request().method() === 'POST' && /\/turns$/.test(response.url()));
  await page.getByRole('button', { name: 'Send' }).click();
  if (timezoneTest || timezoneFallbackTest) {
    const { runId } = await (await admission).json();
    const run = await (await page.request.get(`${base}/api/runs/${runId}`)).json();
    assert.equal(run.timezone, timezoneTest ? 'America/New_York' : 'UTC');
  }
  if (stopRace) {
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.getByText('Browser answer', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('The response completed before it could be stopped.').waitFor();
    console.log('Browser completion-before-cancel race passed.');
  } else if (reconnect) {
    await page.getByRole('button', { name: 'Stop response' }).waitFor();
    await page.reload();
    await page.getByRole('button', { name: /Conversation 1/ }).click();
    await page.getByRole('button', { name: 'Stop response' }).waitFor();
    await page.getByText('Browser answer', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(requestCount, 1);
    assert.equal(await page.locator('article.assistant .content').count(), 1);
    console.log('Browser reconnection passed with a synthetic gateway.');
  } else if (replace) {
    await page.getByRole('button', { name: 'Stop response' }).waitFor();
    await page.getByLabel('Your message').fill('Replacement question');
    await page.waitForTimeout(500);
    assert.equal(requestCount, 1);
    assert.equal(await page.locator('article.user .content').filter({ hasText: 'Replacement question' }).count(), 0);
    await page.getByRole('button', { name: 'Stop and send' }).click();
    await page.getByText('Replacement answer', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await page.locator('article.user .content').filter({ hasText: 'Replacement question' }).count(), 1);
    assert.equal(await page.getByText('Browser answer', { exact: true }).count(), 0);
    console.log('Browser stop-and-send passed with a synthetic gateway.');
  } else if (cancel) {
    await page.getByRole('button', { name: 'Stop response' }).click();
    await page.getByText('Run stopped.').waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('Browser answer', { exact: true }).count(), 0);
    console.log('Browser cancellation passed with a synthetic gateway.');
  } else {
  await page.locator('article.assistant .content').first().waitFor({ timeout: 70000 });
  await page.waitForFunction(() => !document.querySelector('#message')?.disabled, null, { timeout: 70000 });
  assert.equal(await page.getByText(live ? 'Reply exactly: Browser answer' : originalQuestion, { exact: true }).count(), 1);
  const answer = await page.locator('article.assistant .content').first().innerText();
  assert.ok(answer.trim());
  if (!live) assert.equal(answer, 'Browser answer');
  if (process.env.MINMI_TEST_RECALL === '1' || timezoneTest || timezoneFallbackTest) {
    await page.getByLabel('Your message').fill('What did I ask today?');
    await page.getByRole('button', { name: 'Send', exact: false }).click();
    if (timezoneTest || timezoneFallbackTest) {
      await page.getByText(new RegExp(`Found 1 retained question.*${timezoneTest ? 'America/New_York' : 'UTC'}`)).waitFor();
    }
    await page.getByRole('button', { name: 'View original questions' }).click();
    await page.getByRole('region', { name: 'Original questions' }).getByText(originalQuestion, { exact: true }).waitFor();
    if (process.env.MINMI_TEST_RECALL === '1') {
      await page.getByRole('region', { name: 'Original questions' }).getByText(/Relative date in the original message: .*\(.+\)/).waitFor();
    }
    assert.equal(await page.getByRole('region', { name: 'Original questions' }).getByText('What did I ask today?', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Close original questions' }).click();
  }
  if (referenceTest) {
    await page.getByRole('button', { name: '+ New conversation' }).click();
    await page.getByLabel('Your message').fill('We need a CRM shortlist for a larger sales team.');
    await page.getByRole('button', { name: 'Send', exact: false }).click();
    await page.getByText('Browser answer', { exact: true }).last().waitFor({ timeout: 70000 });
    await page.getByRole('button', { name: '+ New conversation' }).click();
    await page.getByLabel('Your message').fill('What about those five CRM tools?');
    await page.getByRole('button', { name: 'Send', exact: false }).click();
    await page.getByText('I found several plausible discussions.', { exact: false }).waitFor({ timeout: 70000 });
    const clarificationButton = page.getByRole('button', { name: 'View discussion source' }).last();
    const clarificationId = await clarificationButton.getAttribute('data-reference-id');
    const clarificationResponse = page.waitForResponse(response => response.url().includes('/api/references/') && response.status() === 200);
    await clarificationButton.click();
    const clarificationPage = await (await clarificationResponse).json();
    assert.equal(clarificationPage.items.length, 2);
    const choices = page.getByRole('region', { name: 'Historical discussion' });
    await choices.getByText(originalQuestion, { exact: true }).waitFor();
    await choices.getByText('We need a CRM shortlist for a larger sales team.', { exact: true }).waitFor();
    await choices.getByRole('button', { name: 'Use option 1' }).click();
    await page.getByRole('button', { name: 'Send', exact: false }).click();
    await page.waitForFunction(id => {
      const assistants = [...document.querySelectorAll('article.assistant .content')];
      const button = assistants.at(-1)?.querySelector('[data-reference-id]');
      return button && button.getAttribute('data-reference-id') !== id;
    }, clarificationId, { timeout: 70000 });
    const resolvedAnswer = page.locator('article.assistant .content').last();
    const resolvedButton = resolvedAnswer.getByRole('button', { name: 'View discussion source' });
    await resolvedButton.waitFor();
    const resolvedResponse = page.waitForResponse(response => response.url().includes('/api/references/') && response.status() === 200);
    await resolvedButton.click();
    const resolvedPage = await (await resolvedResponse).json();
    assert.equal(resolvedPage.items.length, 1);
    assert.equal(resolvedPage.items[0].conversation_title, 'We need a CRM shortlist for a larger sales team.');
    const source = page.getByRole('region', { name: 'Historical discussion' });
    await source.getByText('We need a CRM shortlist for a larger sales team.', { exact: true }).waitFor();
    await source.getByText(/2026/).waitFor();
    await source.getByText('Assistant replied: Browser answer', { exact: true }).waitFor();
    await source.getByRole('button', { name: 'Open source conversation' }).click();
    await page.getByText('We need a CRM shortlist for a larger sales team.', { exact: true }).waitFor();
  }
  await stop(); child = start(); await waitReady();
  await page.reload();
  await page.getByRole('button', { name: /Conversation 1/ }).click();
  await page.locator('article.assistant .content').first().waitFor();
  assert.equal(await page.locator('article.assistant .content').first().innerText(), answer);
  assert.equal(await page.getByText(live ? 'Reply exactly: Browser answer' : originalQuestion, { exact: true }).count(), 1);
  console.log(`Browser chat and restart passed with ${live ? 'the configured live' : 'a synthetic'} gateway.`);
  }
} finally {
  if (browser) await browser.close();
  await stop();
  await new Promise(resolve => gateway.close(resolve));
  await rm(dir, { recursive: true, force: true });
}

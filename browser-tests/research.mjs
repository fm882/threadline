import { chromium } from 'playwright-core';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { localKey, root } from '../scripts/local-env.mjs';

if (existsSync(join(root, '.env'))) process.loadEnvFile(join(root, '.env'));
const liveAssignmentMode = process.argv.includes('--live');
if (liveAssignmentMode && !process.env.TAVILY_API_KEY) throw new Error('TAVILY_API_KEY is required for live assignment evaluation.');
const realInferenceBase = (process.env.INFERENCE_BASE_URL || 'http://127.0.0.1:4000/v1').replace(/\/$/, '');
const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (liveAssignmentMode && !process.env.INFERENCE_API_KEY && !loopbackHosts.has(new URL(realInferenceBase).hostname)) {
  throw new Error('Remote inference requires an explicit INFERENCE_API_KEY; the local gateway key is never sent remotely.');
}
const upstreamKey = liveAssignmentMode ? localKey() : '';
const liveModelUsage = [];
const liveScenarioResults = [];

const dir = await mkdtemp(join(tmpdir(), 'minmi-research-browser-'));
const scenariosDir = await mkdtemp(join(tmpdir(), 'minmi-assignment-browser-'));
const gateway = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  const input = JSON.parse(body);
  const tool = input.messages.find(m => m.role === 'tool');
  const historical = input.messages.some(m => typeof m.content === 'string' && m.content.includes('Authorized historical context'));
  const quoteTurn = input.messages.find(m => m.role === 'user' && typeof m.content === 'string' && /I was quoted/i.test(m.content));
  const userQuote = quoteTurn?.content.match(/I was quoted[^;?]*/)?.[0].trim();
  const historicalSourceIds = [...input.messages.flatMap(m => typeof m.content === 'string' ? [...m.content.matchAll(/\[historical source:([0-9a-f-]{36})\]/gi)].map(match => match[1]) : [])];
  const currentQuestion = input.messages.filter(m => m.role === 'user' && typeof m.content === 'string').at(-1)?.content || '';
  const assignment = /On Monday we shortlisted 5 CRM tools/i.test(currentQuestion) ? 'crm'
    : /What did I ask you on 3 November/i.test(currentQuestion) ? 'dated'
      : /Last Tuesday I asked you about Postgres hosting/i.test(currentQuestion) ? 'postgres' : null;
  if (!tool) assert.match(input.messages[0].content, /requires current evidence|explicitly requests fresh verification/i);
  const source = tool ? JSON.parse(tool.content)[0] : null;
  const message = assignment && !tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: assignment === 'crm' ? 'current pricing and notable product updates for the five shortlisted CRM tools' : 'current Neon and Supabase Postgres hosting prices', subjects: assignment === 'crm' ? ['Acme CRM', 'Northstar CRM', 'Copper CRM', 'Folk CRM', 'Twenty CRM'] : ['Neon Launch', 'Supabase Pro'] }) } }] }
    : assignment && tool ? (() => {
      const sources = JSON.parse(tool.content);
      const subjects = assignment === 'crm' ? ['Acme CRM', 'Northstar CRM', 'Copper CRM', 'Folk CRM', 'Twenty CRM'] : ['Neon Launch', 'Supabase Pro'];
      const claims = sources.map(item => ({ claim: item.excerpt, kind: 'pricing', evidenceIds: [item.id] }));
      const comparisons = subjects.map(subject => {
        const item = sources.find(candidate => candidate.title === subject);
        return { subject, attribute: 'price', outcome: 'historical_support_missing', statement: `Current evidence for ${subject} is available, but the original answer has no source observations, so a change since then is not established.`, baselineOrigin: 'unsupported', baselineStatement: 'No source observations were attached to the original answer.', historicalEvidenceIds: [], evidenceIds: item ? [item.id] : [] };
      });
      const answer = { claims, requestedSubjects: subjects, comparisons, uncertainty: 'These are synthetic browser fixtures; original source support is absent, so historical price changes cannot be established.' };
      return { role: 'assistant', content: JSON.stringify(answer) };
    })()
    : tool ? { role: 'assistant', content: JSON.stringify({ claims: [{ claim: historical ? 'Acme Basic remains USD 12 monthly per seat for US customers before tax.' : 'Acme Basic is USD 12 monthly per seat for US customers before tax. <img src=x onerror=alert(1)> [bad](javascript:alert(1))', kind: 'pricing', evidenceIds: [source.id] }], ...(historical ? { requestedSubjects: ['Acme Basic'], comparisons: [{ subject: 'Acme Basic', attribute: 'price', outcome: 'no_relevant_update_found', statement: 'Among the sources checked, the comparable price matches the earlier finding.', baselineOrigin: 'stored_evidence', baselineStatement: 'Stored source reported the original Acme Basic price.', historicalEvidenceIds: historicalSourceIds, evidenceIds: [source.id], priorDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' }, currentDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' } }] } : userQuote ? { requestedSubjects: ['Acme Basic'], comparisons: [{ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'The current price exceeds the user-reported quote.', baselineOrigin: 'user_reported', userQuote, historicalEvidenceIds: [], evidenceIds: [source.id], priorDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' }, currentDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' } }] } : {}), uncertainty: 'Recorded fixture.' }) }
      : { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"current information"}' } }] };
  if (tool) await new Promise(resolve => setTimeout(resolve, 800));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ id: 'fixture', object: 'chat.completion', created: 1, model: 'chat-main-v1', choices: [{ index: 0, message, finish_reason: tool ? 'stop' : 'tool_calls' }] }));
});
gateway.listen(0, '127.0.0.1'); await once(gateway, 'listening');
const gatewayPort = gateway.address().port;
const apiPort = process.env.MINMI_RESEARCH_PORT || '3458';
let inferenceRelay, inferenceRelayPort;
if (liveAssignmentMode) {
  inferenceRelay = createServer(async (req, res) => {
    let raw = ''; for await (const part of req) raw += part;
    const request = JSON.parse(raw || '{}');
    const model = request.model;
    if (!['chat-main-v1', 'chat-fast-v1'].includes(model)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unexpected model alias.', type: 'invalid_request_error' } }));
      return;
    }
    if (liveModelUsage.length >= 12) {
      res.writeHead(429, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Live assignment model-call limit reached.', type: 'rate_limit_error' } }));
      return;
    }
    const response = await fetch(new URL(req.url || '/v1/chat/completions', realInferenceBase), {
      method: req.method || 'POST',
      headers: { authorization: `Bearer ${process.env.INFERENCE_API_KEY || upstreamKey}`, 'content-type': 'application/json' },
      body: raw || undefined,
      signal: AbortSignal.timeout(120_000),
    });
    const body = await response.text();
    const record = { at: new Date().toISOString(), model, status: response.status };
    if (response.ok) {
      try {
        const parsed = JSON.parse(body);
        const choice = parsed.choices?.[0];
        const toolCalls = choice?.message?.tool_calls || [];
        const toolCall = toolCalls[0];
        let toolArguments = null;
        try { if (toolCall?.function?.arguments) toolArguments = JSON.parse(toolCall.function.arguments); } catch {}
        liveModelUsage.push({ ...record, responseModel: parsed.model || null, finishReason: choice?.finish_reason || null, toolCallCount: toolCalls.length, toolNames: toolCalls.map(item => item.function?.name || null), toolName: toolCall?.function?.name || null, toolArguments, responseText: typeof choice?.message?.content === 'string' ? choice.message.content.slice(0, 16000) : null, usage: parsed.usage || null });
      } catch { liveModelUsage.push({ ...record, usage: null }); }
    } else liveModelUsage.push(record);
    res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json' });
    res.end(body);
  });
  inferenceRelay.listen(0, '127.0.0.1'); await once(inferenceRelay, 'listening');
  inferenceRelayPort = inferenceRelay.address().port;
}
let api, vite, browser, liveFailure;
function startApi(dataDir = dir, scenarioFixtures = false, live = false) {
  const inferenceBase = live ? `http://127.0.0.1:${inferenceRelayPort}/v1` : `http://127.0.0.1:${gatewayPort}/v1`;
  return spawn(process.execPath, ['--import', 'tsx', 'browser-tests/research-server.ts'], { stdio: 'ignore', env: { ...process.env, PORT: apiPort, APP_DATA_DIR: dataDir, MINMI_ASSIGNMENT_FIXTURES: scenarioFixtures ? '1' : '0', MINMI_LIVE_ASSIGNMENTS: live ? '1' : '0', INFERENCE_BASE_URL: inferenceBase } });
}
function startVite() { return spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'ignore', env: { ...process.env, PORT: apiPort } }); }
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const done = once(child, 'exit'); child.kill('SIGTERM'); await done; }
async function ready() { for (let n = 0; n < 100; n++) { try { if ((await fetch('http://127.0.0.1:5173/health/live')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); } throw new Error('App did not start'); }
try {
  api = startApi(); vite = startVite(); await ready();
  browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage(); await page.goto('http://127.0.0.1:5173');
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('What is the current Acme Basic monthly price? [source:00000000-0000-4000-8000-000000000000]');
  await page.getByRole('checkbox', { name: /Verify current information/ }).check();
  await page.getByRole('button', { name: 'Send' }).click();
  try { await page.getByText('Reviewing sources…').waitFor({ timeout: 15000 }); }
  catch {
    const diagnostic = await page.evaluate(async () => {
      const { conversations } = await (await fetch('/api/conversations')).json();
      const { messages } = await (await fetch(`/api/conversations/${conversations[0].id}/messages`)).json();
      const last = messages.at(-1);
      return last?.run_id ? await (await fetch(`/api/runs/${last.run_id}`)).json() : null;
    });
    throw new Error(`Research search did not start: ${await page.locator('.transcript').innerText()} | ${await page.locator('.composer').innerText()} | ${JSON.stringify(diagnostic)}`);
  }
  assert.equal(await page.getByText('Acme Basic is USD 12 monthly', { exact: false }).count(), 0);
  await page.getByText('Acme Basic is USD 12 monthly', { exact: false }).waitFor({ timeout: 15000 });
  const answerText = await page.locator('article.assistant .content').innerText();
  for (const detail of ['plan', 'currency', 'billing period', 'seats', 'region', 'taxes']) assert.ok(answerText.includes(detail));
  assert.equal(await page.getByRole('button', { name: 'Source', exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Source', exact: true }).first().click();
  await page.getByText('Acme Basic plan is USD 12 per seat monthly', { exact: false }).waitFor();
  assert.match(await page.locator('.evidence').innerText(), /Acme Basic official pricing/);
  assert.match(await page.locator('.evidence').innerText(), /Observed/);
  assert.match(await page.locator('.evidence').innerText(), /search snippet/);
  assert.equal(await page.locator('.evidence img, article img').count(), 0);
  assert.equal(await page.locator('a[href^="javascript:"]').count(), 0);
  assert.match(await page.locator('.evidence blockquote').innerText(), /<img src=x/);

  await page.getByRole('button', { name: 'Close source details' }).click();
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('Has the Acme Basic price changed since our earlier answer?');
  await page.getByRole('button', { name: 'Send' }).click();
  try { await page.getByText('Among the sources checked, the comparable price matches the earlier finding.', { exact: false }).waitFor({ timeout: 15000 }); } catch { throw new Error(`Historical comparison failed: ${await page.locator('.transcript').innerText()} | ${await page.locator('.composer').innerText()}`); }
  const comparison = page.locator('article.assistant .content').last();
  assert.match(await comparison.innerText(), /Evidence supports now:/);
  assert.match(await comparison.innerText(), /Comparison by subject:/);
  await comparison.getByRole('button', { name: 'View discussion source' }).click();
  const historical = page.getByRole('region', { name: 'Historical discussion' });
  await historical.getByText('Sources cited then', { exact: true }).waitFor();
  await historical.getByText('Acme Basic plan is USD 12 per seat monthly', { exact: false }).waitFor();
  assert.match(await historical.getByText(/Assistant replied:/).innerText(), /Acme Basic is USD 12 monthly per seat for US customers before tax/);

  await page.getByRole('button', { name: 'Close historical discussion' }).click();
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('I was quoted USD 18 monthly for Acme Basic; compare it with current pricing.');
  await page.getByRole('button', { name: 'Send' }).click();
  try { await page.getByText('User-reported quote (not independently verified)', { exact: false }).waitFor({ timeout: 15000 }); }
  catch { throw new Error(`Quote comparison did not publish: ${await page.locator('.transcript').innerText()} | composer: ${await page.locator('.composer').innerText()}`); }
  const quoteComparison = await page.locator('article.assistant .content').last().innerText();
  assert.match(quoteComparison, /I was quoted USD 18 monthly for Acme Basic/);
  assert.match(quoteComparison, /Acme Basic \(price; supported_change\)/);

  await stop(api); api = startApi(); await ready(); await page.reload();
  await page.getByRole('button', { name: /Conversation 3/ }).click();
  await page.getByRole('button', { name: 'Source', exact: true }).first().click();
  await page.getByText('Acme Basic plan is USD 12 per seat monthly', { exact: false }).waitFor();
  console.log('Three-layer historical comparison and source inspection survived restart.');

  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('Which customer relationship tools did we compare earlier?');
  await page.getByRole('button', { name: 'Send' }).click();
  await page.getByText('We previously compared Acme CRM and Northstar CRM for the nonprofit.', { exact: false }).waitFor({ timeout: 15000 });
  const paraphrase = page.locator('article.assistant .content').last();
  await paraphrase.getByRole('button', { name: 'View discussion source' }).click();
  const paraphraseHistory = page.getByRole('region', { name: 'Historical discussion' });
  await paraphraseHistory.getByText('CRM shortlist for a nonprofit', { exact: true }).waitFor();
  assert.match(await paraphraseHistory.innerText(), /We compared Acme CRM and Northstar CRM/);
  await stop(api); api = startApi(); await ready(); await page.reload();
  let restoredParaphrase = false;
  const conversationButtons = page.locator('nav[aria-label="Conversations"] button');
  for (let index = 0; index < await conversationButtons.count(); index++) {
    await conversationButtons.nth(index).click();
    try { await page.getByText('Which customer relationship tools did we compare earlier?', { exact: true }).waitFor({ timeout: 1000 }); restoredParaphrase = true; break; } catch {}
  }
  assert.ok(restoredParaphrase, 'The paraphrased history conversation should remain accessible after restart.');
  await page.getByRole('button', { name: 'View discussion source' }).click();
  await page.getByRole('region', { name: 'Historical discussion' }).getByText('CRM shortlist for a nonprofit', { exact: true }).waitFor();
  console.log('Paraphrased hybrid history retrieval and snapshot inspection survived restart.');

  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('[deadline fixture] Research current CRM pricing.');
  await page.getByRole('button', { name: 'Send' }).click();
  try { await page.getByText('Northstar CRM', { exact: false }).waitFor({ timeout: 15000 }); }
  catch { throw new Error(`Deadline run did not list its named subject gaps: ${await page.locator('.transcript').innerText()} | ${await page.locator('.composer').innerText()}`); }
  const partialArticle = page.locator('article.assistant').last();
  assert.match(await partialArticle.innerText(), /Partial source observations/);
  assert.match(await partialArticle.innerText(), /Northstar CRM/);
  await partialArticle.getByRole('button', { name: 'Source', exact: true }).click();
  await page.getByText('Acme CRM Growth costs USD 12 per seat monthly', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Close source details' }).click();
  await page.getByRole('button', { name: 'Continue research' }).click();
  await page.getByText('Continuation completed with a fresh time limit.', { exact: true }).waitFor({ timeout: 15000 });
  const continuationLink = await page.evaluate(async () => {
    const { conversations } = await (await fetch('/api/conversations')).json();
    const { messages } = await (await fetch(`/api/conversations/${conversations[0].id}/messages`)).json();
    const parent = messages.find(message => message.role === 'assistant' && message.run_status === 'incomplete');
    const child = messages.at(-1);
    const run = await (await fetch(`/api/runs/${child.run_id}`)).json();
    return { parentRunId: parent.run_id, linkedParentRunId: run.parent_run_id, childStatus: run.status };
  });
  assert.equal(continuationLink.linkedParentRunId, continuationLink.parentRunId);
  assert.equal(continuationLink.childStatus, 'completed');
  console.log('Deadline limitation and explicit linked continuation survived the browser flow.');

  await stop(api); api = startApi(scenariosDir, true, liveAssignmentMode); await ready(); await page.goto('http://127.0.0.1:5173');
  const assignmentTimeout = liveAssignmentMode ? 125_000 : 15_000;
  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?');
  const crmModelRequestStart = liveModelUsage.length;
  await page.getByRole('button', { name: 'Send' }).click();
  let crmRun;
  if (liveAssignmentMode) crmRun = await waitForLiveRun(page, assignmentTimeout, 'On Monday we shortlisted 5 CRM tools');
  else {
    try { await page.getByText('historical_support_missing', { exact: false }).waitFor({ timeout: assignmentTimeout }); }
    catch { throw new Error(`CRM assignment scenario did not publish a qualified comparison: ${await page.locator('.transcript').innerText()} | ${await page.locator('.composer').innerText()}`); }
  }
  let assignmentAnswer = liveAssignmentMode
    ? await page.locator('article.assistant .content').count().then(count => count ? page.locator('article.assistant .content').last().innerText() : '')
    : await page.locator('article.assistant .content').last().innerText();
  if (!liveAssignmentMode) {
    for (const name of ['Acme CRM', 'Northstar CRM', 'Copper CRM', 'Folk CRM', 'Twenty CRM']) assert.ok(assignmentAnswer.includes(name), `CRM answer should cover ${name}.`);
    assert.match(assignmentAnswer, /Evidence supports now:/);
    assert.match(assignmentAnswer, /No source observations were attached/);
  }
  const crmCitationButtons = await page.locator('article.assistant .content').last().getByRole('button', { name: 'Source', exact: true }).count();
  if (!liveAssignmentMode) assert.ok(crmCitationButtons >= 5, `Expected citations for all CRM subjects, received ${crmCitationButtons}.`);
  if (liveAssignmentMode) { const result = await captureLiveScenario('crm-shortlist', assignmentAnswer, crmRun, crmModelRequestStart); liveScenarioResults.push(result); assignmentAnswer ||= result.answer; }
  if (!liveAssignmentMode || (liveScenarioResults.at(-1)?.status === 'completed' && await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).count())) {
    await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).click();
    const crmHistory = page.getByRole('region', { name: 'Historical discussion' });
    await crmHistory.getByText('CRM shortlist for a 20-person sales team', { exact: true }).waitFor();
    assert.match(await crmHistory.innerText(), /Acme CRM, Northstar CRM, Copper CRM, Folk CRM, and Twenty CRM/);
    await page.getByRole('button', { name: 'Close historical discussion' }).click();
  }

  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('What did I ask you on 3 November? Is your answer still correct today?');
  const datedModelRequestStart = liveModelUsage.length;
  await page.getByRole('button', { name: 'Send' }).click();
  let datedRun;
  if (liveAssignmentMode) datedRun = await waitForLiveRun(page, assignmentTimeout, 'What did I ask you on 3 November');
  else await page.getByText('historical_support_missing', { exact: false }).waitFor({ timeout: assignmentTimeout });
  assignmentAnswer = liveAssignmentMode
    ? await page.locator('article.assistant .content').count().then(count => count ? page.locator('article.assistant .content').last().innerText() : '')
    : await page.locator('article.assistant .content').last().innerText();
  if (!liveAssignmentMode) {
    assert.match(assignmentAnswer, /Neon Launch/);
    assert.match(assignmentAnswer, /Supabase Pro/);
    assert.match(assignmentAnswer, /Evidence supports now:/);
    assert.ok(await page.locator('article.assistant .content').last().getByRole('button', { name: 'Source', exact: true }).count() >= 2);
  }
  if (liveAssignmentMode) { const result = await captureLiveScenario('dated-postgres', assignmentAnswer, datedRun, datedModelRequestStart); liveScenarioResults.push(result); assignmentAnswer ||= result.answer; }
  if (!liveAssignmentMode || (liveScenarioResults.at(-1)?.status === 'completed' && await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).count())) {
    await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).click();
    const datedHistory = page.getByRole('region', { name: 'Historical discussion' });
    await datedHistory.getByText('Question from 3 November 2026', { exact: true }).waitFor();
    assert.match(await datedHistory.innerText(), /Which Postgres host should I use for a hobby application/);
    await page.getByRole('button', { name: 'Close historical discussion' }).click();
  }

  await page.getByRole('button', { name: '+ New conversation' }).click();
  await page.getByLabel('Your message').fill('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?');
  const tuesdayModelRequestStart = liveModelUsage.length;
  await page.getByRole('button', { name: 'Send' }).click();
  let tuesdayRun;
  if (liveAssignmentMode) tuesdayRun = await waitForLiveRun(page, assignmentTimeout, 'Last Tuesday I asked you about Postgres hosting');
  else await page.getByText('historical_support_missing', { exact: false }).waitFor({ timeout: assignmentTimeout });
  assignmentAnswer = liveAssignmentMode
    ? await page.locator('article.assistant .content').count().then(count => count ? page.locator('article.assistant .content').last().innerText() : '')
    : await page.locator('article.assistant .content').last().innerText();
  if (!liveAssignmentMode) {
    assert.match(assignmentAnswer, /Neon Launch/);
    assert.match(assignmentAnswer, /Supabase Pro/);
    assert.match(assignmentAnswer, /No source observations were attached/);
    assert.ok(await page.locator('article.assistant .content').last().getByRole('button', { name: 'Source', exact: true }).count() >= 2);
  }
  if (liveAssignmentMode) { const result = await captureLiveScenario('last-tuesday-postgres', assignmentAnswer, tuesdayRun, tuesdayModelRequestStart); liveScenarioResults.push(result); assignmentAnswer ||= result.answer; }
  if (!liveAssignmentMode || (liveScenarioResults.at(-1)?.status === 'completed' && await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).count())) {
    await page.locator('article.assistant .content').last().getByRole('button', { name: 'View discussion source' }).click();
    const postgresHistory = page.getByRole('region', { name: 'Historical discussion' });
    await postgresHistory.getByText('Postgres hosting from last Tuesday', { exact: true }).waitFor();
    assert.match(await postgresHistory.innerText(), /Neon Launch was USD 19 monthly and Supabase Pro was USD 25 monthly/);
  }
  if (liveAssignmentMode) {
    const runsPath = join(scenariosDir, 'live-evaluation-runs.json');
    const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, 'utf8')) : [];
    const report = {
      checkedAt: new Date().toISOString(),
      sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      runtime: { node: process.version, litellm: execFileSync(process.env.LITELLM_BIN || 'litellm', ['--version'], { encoding: 'utf8' }).trim() },
      scope: 'Live application browser evaluation using LiteLLM, Token Harbor DeepSeek V4.1 Flash Free, and Tavily Basic; no private conversation input.',
      routes: { main: { provider: 'Token Harbor', model: 'deepseek-v4.1-flash:free', endpoint: 'https://tokenharbor.ai/v1' }, fastFallback: { provider: 'AWS Bedrock', route: process.env.BEDROCK_FAST_ROUTE || 'bedrock/converse/us.amazon.nova-micro-v1:0' } },
      routeConfigSha256: createHash('sha256').update(readFileSync(join(root, 'infra/litellm/config.yaml'))).digest('hex'),
      modelRequests: liveModelUsage,
      modelCallCount: liveModelUsage.length,
      runs,
      tavilyBasicSearchCalls: runs.reduce((sum, run) => sum + run.searchQueries, 0),
      scenarios: liveScenarioResults.map(result => ({ ...result, budget: runs.find(run => run.runId === result.runId) || null })),
      harnessCompleted: runs.length === 3 && liveModelUsage.length <= 12,
      providerExecution: runs.length === 3 && runs.every(run => run.status === 'completed') ? 'all_scenarios_completed' : 'provider_or_application_failures_present',
      researchQuality: 'pending_human_grounded_rubric',
      monetaryCost: 'unknown_pending_provider_usage_reconciliation',
      billedCost: 'unknown; reconcile AWS and Tavily account usage after provider records settle',
    };
    const reportDir = join(root, '.data'); mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const reportPath = join(reportDir, `live-research-evaluation-${Date.now()}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`Live research report: ${reportPath}`);
    assert.equal(liveScenarioResults.length, 3);
    assert.equal(runs.length, 3, 'All three live assignment runs must persist metrics.');
    assert.ok(liveModelUsage.length <= 12, 'Live assignment batch exceeded the 12 model-call limit.');
    console.log('Live CRM, dated Postgres, and last-Tuesday Postgres scenarios completed; quality outcomes are recorded in the report.');
  } else console.log('CRM shortlist, dated verification, and Postgres comparisons retrieved originals and cited current fixture evidence.');
} catch (error) {
  liveFailure = String(error?.message || error).slice(0, 1600);
  throw error;
} finally {
  if (liveAssignmentMode) {
    const runsPath = join(scenariosDir, 'live-evaluation-runs.json');
    const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, 'utf8')) : [];
    const report = { checkedAt: new Date().toISOString(), harnessCompleted: runs.length === 3 && liveModelUsage.length <= 12, providerExecution: runs.length === 3 && runs.every(run => run.status === 'completed') ? 'all_scenarios_completed' : 'provider_or_application_failures_present', researchQuality: 'pending_human_grounded_rubric', monetaryCost: 'unknown_pending_provider_usage_reconciliation', error: liveFailure || undefined, modelRequests: liveModelUsage, runs, scenarios: liveScenarioResults.map(result => ({ ...result, budget: runs.find(run => run.runId === result.runId) || null })) };
    const reportDir = join(root, '.data'); mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    if (liveScenarioResults.length < 3) writeFileSync(join(reportDir, `live-research-partial-${Date.now()}.json`), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  if (browser) await browser.close();
  await stop(api); await stop(vite); if (inferenceRelay) await new Promise(resolve => inferenceRelay.close(resolve)); await new Promise(resolve => gateway.close(resolve));
  await rm(dir, { recursive: true, force: true });
  await rm(scenariosDir, { recursive: true, force: true });
}

async function captureLiveScenario(name, answer, run, modelRequestStart) {
  return { name, ...run, answer: run?.answer || answer || '', modelRequests: liveModelUsage.slice(modelRequestStart) };
}

async function waitForLiveRun(page, timeout, expected) {
  const runId = await page.waitForFunction(async expectedQuestion => {
    const { conversations } = await (await fetch('/api/conversations')).json();
    for (const conversation of conversations) {
      const { messages } = await (await fetch(`/api/conversations/${conversation.id}/messages`)).json();
      const user = messages.find(message => message.role === 'user' && message.content?.includes(expectedQuestion));
      if (user?.run_id) return user.run_id;
    }
    return null;
  }, expected, { timeout, polling: 500 });
  const id = await runId.jsonValue();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const runs = JSON.parse(readFileSync(join(scenariosDir, 'live-evaluation-runs.json'), 'utf8'));
      const run = runs.find(item => item.runId === id);
      if (run) return run;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Live run ${id} did not persist terminal metrics within ${timeout}ms.`);
}

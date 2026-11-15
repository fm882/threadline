import { it, expect } from 'vitest';
import { interpretHistoricalRequest } from '../src/history/reference.js';

const now = new Date('2026-06-10T12:00:00Z');

it('interprets the discussion date independently from a comparison interval', () => {
  const request = interpretHistoricalRequest('On Monday we shortlisted 5 CRM tools. Have any of them changed pricing since last Tuesday?', now, 'UTC');
  expect(request.needed).toBe(true);
  expect(request.discussion).toMatchObject({ status: 'resolved', date: '2026-06-08' });
  expect(request.comparison).toMatchObject({ status: 'resolved', date: '2026-06-09' });
  expect(request.terms).toContain('crm');
});

it('detects historical references without treating an unrelated question as history search', () => {
  expect(interpretHistoricalRequest('What about those five?', now, 'UTC').needed).toBe(true);
  expect(interpretHistoricalRequest('We shortlisted five CRM tools for a 20-person sales team.', now, 'UTC').needed).toBe(false);
  expect(interpretHistoricalRequest('What is the current population of Delhi?', now, 'UTC').needed).toBe(false);
});

it('uses same-conversation continuity only for anaphoric references', () => {
  const continuity = 'What is the current population of Delhi? Population answer.';
  const explicit = interpretHistoricalRequest('What did we decide in the earlier CRM shortlist?', now, 'UTC', continuity);
  expect(explicit.terms).toContain('crm');
  expect(explicit.terms).not.toContain('population');
  const anaphoric = interpretHistoricalRequest('What about those five?', now, 'UTC', 'We shortlisted five CRM tools for sales teams.');
  expect(anaphoric.terms).toContain('crm');
  expect(anaphoric.terms).toContain('sales');
});

it('does not treat a comparison date as a discussion-date filter', () => {
  const request = interpretHistoricalRequest('Has any of them changed pricing since Monday?', now, 'UTC');
  expect(request.discussion.status).toBe('not_recognized');
  expect(request.comparison).toMatchObject({ status: 'resolved', date: '2026-06-08' });
});

it('uses a leading weekday to locate the old discussion', () => {
  const request = interpretHistoricalRequest('Last Tuesday I asked about Postgres hosting. Has any pricing changed since then?', now, 'UTC');
  expect(request.discussion).toMatchObject({ status: 'resolved', date: '2026-06-09' });
  expect(request.comparison.status).toBe('not_recognized');
});

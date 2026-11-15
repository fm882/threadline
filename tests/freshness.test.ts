import { it, expect } from 'vitest';
import { freshnessNotice, requiresCurrentVerification } from '../src/research/freshness.js';

it('distinguishes explicit current verification from ordinary chat', () => {
  for (const input of ['Is it still correct?', 'What changed since then?', 'What is the latest price today?', 'Is it currently available?']) expect(requiresCurrentVerification(input)).toBe(true);
  for (const input of ['Hello', 'Explain how pricing works', 'What did I ask last week?']) expect(requiresCurrentVerification(input)).toBe(false);
});

it('uses the oldest actual observation and discloses stale evidence', () => {
  const now = new Date('2026-01-03T12:00:00Z');
  expect(freshnessNotice(['2026-01-03T10:00:00Z', '2026-01-02T10:00:00Z'], now)).toEqual({ asOf: '2026-01-02T10:00:00.000Z', stale: true });
  expect(freshnessNotice(['2026-01-03T11:00:00Z'], now).stale).toBe(false);
  expect(() => freshnessNotice(['invalid'], now)).toThrow();
  expect(() => freshnessNotice(['2026-02-01T00:00:00Z'], now)).toThrow();
});

import { it, expect } from 'vitest';
import { interpretDateReference } from '../src/history/date-reference.js';

it('anchors relative and yearless dates to the recorded local date', () => {
  const time = new Date('2026-01-01T02:00:00Z');
  expect(interpretDateReference('yesterday', time, 'America/New_York')).toMatchObject({ status: 'resolved', date: '2025-12-30' });
  expect(interpretDateReference('3 November', time, 'America/New_York')).toMatchObject({ status: 'resolved', date: '2025-11-03' });
  expect(interpretDateReference('3 November', time, 'Asia/Kolkata')).toMatchObject({ status: 'resolved', date: '2025-11-03' });
});

it('requests clarification for ambiguous and invalid dates', () => {
  const time = new Date('2026-06-01T00:00:00Z');
  expect(interpretDateReference('03/11', time, 'UTC').status).toBe('clarification_needed');
  expect(interpretDateReference('30 February 2026', time, 'UTC').status).toBe('clarification_needed');
  expect(interpretDateReference('2025-11-03', time, 'UTC')).toMatchObject({ status: 'resolved', date: '2025-11-03' });
  expect(interpretDateReference('3 November and 4 November', time, 'UTC').status).toBe('clarification_needed');
  expect(interpretDateReference('last Tuesday', time, 'UTC')).toMatchObject({ status: 'resolved', date: '2026-05-26' });
  expect(interpretDateReference('yesterday and 03/11', time, 'UTC').status).toBe('clarification_needed');
});

it('understands month-first and abbreviated month names without guessing a numeric format', () => {
  const time = new Date('2026-06-01T00:00:00Z');
  expect(interpretDateReference('November 3, 2025', time, 'UTC')).toMatchObject({ status: 'resolved', date: '2025-11-03' });
  expect(interpretDateReference('3 Nov 2025', time, 'UTC')).toMatchObject({ status: 'resolved', date: '2025-11-03' });
  expect(interpretDateReference('Mar 4', time, 'UTC')).toMatchObject({ status: 'resolved', date: '2026-03-04' });
});

it('uses the most recent valid leap day when the year is omitted', () => {
  expect(interpretDateReference('29 February', new Date('2026-03-01T00:00:00Z'), 'UTC')).toMatchObject({ status: 'resolved', date: '2024-02-29', yearOmitted: true });
  expect(interpretDateReference('29 February 2025', new Date('2026-03-01T00:00:00Z'), 'UTC').status).toBe('clarification_needed');
});

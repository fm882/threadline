import { it, expect } from 'vitest';
import { qualifyPriceClaim, isPricingQuestion } from '../src/answers/qualification.js';
import { isHistoricalComparisonRequest, qualifyComparison, validateSubjectCoverage, type ResearchComparison } from '../src/research/research-client.js';

const comparison = (overrides: Partial<ResearchComparison> = {}): ResearchComparison => ({ subject: 'Acme Basic', attribute: 'price', outcome: 'supported_change', statement: 'The price changed.', evidenceIds: ['current'], baselineOrigin: 'unsupported', historicalEvidenceIds: [], baselineConflict: false, priorDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' }, currentDimensions: { plan: 'Basic', currency: 'USD', billingPeriod: 'monthly', seats: 1, region: 'US', taxBasis: 'before tax' }, ...overrides });

it('qualifies incomplete price passages with the dimensions needed to interpret them', () => {
  for (const claim of ['The price is $20.', 'The plan costs 12 USD.', 'The subscription is available.', 'It costs twenty dollars.', 'The service is 10 euros per user.', 'They charge 99 rupees.', 'The service is free.', 'There is a trial.', 'The entry tier starts at 12.', 'It starts at 12.', 'The service is complimentary.', 'A monthly payment of twelve applies.', 'The offer is fifteen per head.']) {
    const result = qualifyPriceClaim(claim);
    expect(result).toContain(claim);
    for (const detail of ['plan', 'currency', 'billing period', 'seats', 'region', 'taxes']) expect(result).toContain(detail);
  }
  expect(qualifyPriceClaim('The product launched a new integration.')).toBe('The product launched a new integration.');
  expect(isPricingQuestion('Has the fee changed?')).toBe(true);
  expect(qualifyPriceClaim('The offer changed.', true)).toContain('billing period');
});

it('rejects non-comparable annual and monthly prices and incomplete dimensions', () => {
  const annual = qualifyComparison(comparison({ currentDimensions: { ...comparison().currentDimensions, billingPeriod: 'annual' } }), [{ title: 'Pricing', excerpt: '$120 per year' }], false);
  expect(annual.outcome).toBe('inconclusive');
  expect(annual.statement).toContain('billing period');
  const missing = qualifyComparison(comparison({ priorDimensions: { plan: 'Basic' } }), [{ title: 'Pricing', excerpt: '$20' }], false);
  expect(missing.outcome).toBe('inconclusive');
});

it('keeps stale and contradictory current pricing inconclusive', () => {
  const stale = qualifyComparison(comparison(), [{ title: 'Pricing', excerpt: '$20 monthly' }], true);
  expect(stale.outcome).toBe('inconclusive');
  expect(stale.statement).toContain('may be stale');
  const conflict = qualifyComparison(comparison(), [{ title: 'Official pricing', excerpt: '$20 monthly' }, { title: 'Official regional pricing', excerpt: '$30 monthly' }], false);
  expect(conflict.outcome).toBe('inconclusive');
  expect(conflict.statement).toContain('conflicting price amounts');
});

it('qualifies no-update findings and downgrades prior-error claims without historical support', () => {
  const noUpdate = qualifyComparison(comparison({ outcome: 'no_relevant_update_found', statement: 'Nothing changed.' }), [{ title: 'Pricing', excerpt: '$20 monthly' }], false);
  expect(noUpdate.statement).toContain('Among the sources checked');
  const unsupported = qualifyComparison(comparison({ outcome: 'prior_error' }), [{ title: 'Current pricing', excerpt: '$20 monthly' }], false, false);
  expect(unsupported.outcome).toBe('historical_support_missing');
  expect(unsupported.statement).toContain('cannot establish that the earlier answer was wrong');
  const undated = qualifyComparison(comparison({ outcome: 'prior_error' }), [{ title: 'Current pricing', excerpt: 'Acme Basic is USD 20 monthly.' }], false, true);
  expect(undated.outcome).toBe('inconclusive');
  expect(undated.statement).toContain('does not identify the earlier period');
});

it('attributes user quotes and reconstructs only a source-supported earlier period', async () => {
  const { qualifyBaseline } = await import('../src/research/research-client.js');
  const quote = qualifyBaseline(comparison({ baselineOrigin: 'user_reported', userQuote: 'I was quoted USD 18 monthly', outcome: 'supported_change' }), 'I was quoted USD 18 monthly for Acme Basic; how does that compare?', new Set(), []);
  expect(quote.baselineOrigin).toBe('user_reported');
  expect(quote.baselineStatement).toContain('not independently verified');
  expect(() => qualifyBaseline(comparison({ baselineOrigin: 'user_reported', userQuote: 'USD 18', outcome: 'supported_change' }), 'Acme Basic price?', new Set(), [])).toThrow('supplied in this turn');

  const source = { id: '00000000-0000-4000-8000-000000000001', title: 'Acme Basic June 2026 prices', excerpt: 'For June 2026, Acme Basic cost USD 18 monthly.' };
  const reconstructed = qualifyBaseline(comparison({ baselineOrigin: 'reconstructed', baselineStatement: 'Acme Basic was USD 18 monthly.', baselinePeriod: 'June 2026', historicalEvidenceIds: [source.id] }), 'Has the price changed since then?', new Set(), [source]);
  expect(reconstructed.baselineOrigin).toBe('reconstructed');
  expect(reconstructed.baselineStatement).toContain('evidence found now');
  const currentOnly = qualifyBaseline(comparison({ baselineOrigin: 'reconstructed', baselineStatement: 'Acme Basic was USD 18 monthly.', baselinePeriod: 'June 2026', historicalEvidenceIds: [source.id] }), 'Has the price changed since then?', new Set(), [{ ...source, excerpt: 'Acme Basic currently costs USD 20 monthly.' }]);
  expect(currentOnly.baselineOrigin).toBe('unsupported');
  expect(currentOnly.outcome).toBe('inconclusive');
  const mixed = qualifyBaseline(comparison({ baselineOrigin: 'mixed', baselineStatement: 'June 2026 pricing was USD 18.', baselinePeriod: 'June 2026', historicalEvidenceIds: ['stored-source', source.id] }), 'Has the price changed?', new Set(['stored-source']), [source]);
  expect(mixed.baselineOrigin).toBe('mixed');
  expect(mixed.baselineStatement).toContain('sources attached then and historical evidence found now');
  const conflictingQuote = qualifyBaseline(comparison({ baselineOrigin: 'user_reported', userQuote: 'I was quoted USD 18 monthly', baselineConflict: true, outcome: 'supported_change' }), 'I was quoted USD 18 monthly; another quote was USD 21.', new Set(), []);
  expect(conflictingQuote.baselineOrigin).toBe('user_reported');
  expect(conflictingQuote.outcome).toBe('inconclusive');
  expect(conflictingQuote.statement).toContain('sources conflict');
});

it('requires current evidence for historical comparison wording even without current-date keywords', () => {
  expect(isHistoricalComparisonRequest('Has the price changed?')).toBe(true);
  expect(isHistoricalComparisonRequest('Is the earlier answer still correct?')).toBe(true);
  expect(isHistoricalComparisonRequest('Can you explain that shortlist?')).toBe(false);
});

it('requires one finding or explicit gap for each requested subject', () => {
  const first = comparison({ subject: 'Acme' });
  const second = comparison({ subject: 'Bravo', attribute: 'release update' });
  expect(() => validateSubjectCoverage(['Acme', 'Bravo'], [first, second])).not.toThrow();
  expect(() => validateSubjectCoverage(['Acme', 'Bravo'], [first])).toThrow('Every requested comparison subject');
  expect(() => validateSubjectCoverage(['Acme', 'Acme'], [first, first])).toThrow('Every requested comparison subject');
});

import { it, expect } from 'vitest';
import { qualifyPriceClaim, isPricingQuestion } from '../src/answers/qualification.js';

it('qualifies incomplete price passages with the dimensions needed to interpret them', () => {
  for (const claim of ['The price is $20.', 'The plan costs 12 USD.', 'The subscription is available.', 'It costs twenty dollars.', 'The service is 10 euros per user.', 'They charge 99 rupees.']) {
    const result = qualifyPriceClaim(claim);
    expect(result).toContain(claim);
    for (const detail of ['plan', 'currency', 'billing period', 'seats', 'region', 'taxes']) expect(result).toContain(detail);
  }
  expect(qualifyPriceClaim('The product launched a new integration.')).toBe('The product launched a new integration.');
  expect(isPricingQuestion('Has the fee changed?')).toBe(true);
  expect(qualifyPriceClaim('The offer changed.', true)).toContain('billing period');
});

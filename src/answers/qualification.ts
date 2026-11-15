const priceLanguage = /(?:\b(?:pric(?:e|es|ed|ing)|cost(?:s|ing)?|fees?|subscriptions?|charg(?:e|es|ed|ing)|tariffs?|rates?|per (?:month|year|seat|user))\b|[$€£₹]\s*\d|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|inr|dollars?|euros?|pounds?|rupees?)\b)/i;
const caveat = 'Pricing may depend on the plan, currency, billing period, number of seats, region, and taxes; verify any details not shown in the cited source.';

/** Conservatively qualify price passages and answers to explicit pricing questions. */
export function qualifyPriceClaim(claim: string, pricingQuestion = false): string {
  return pricingQuestion || priceLanguage.test(claim) ? `${claim} ${caveat}` : claim;
}

export function isPricingQuestion(input: string): boolean {
  return priceLanguage.test(input);
}

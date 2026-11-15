const priceLanguage = /(?:\b(?:pric(?:e|es|ed|ing)|cost(?:s|ing)?|fees?|subscriptions?|charg(?:e|es|ed|ing)|tariffs?|rates?|free|complimentary|trial|billed|billing|payments?|installments?|discounts?|monthly|annually|yearly|weekly|per (?:month|year|annum|seat|user|person|head|member))\b|[$€£₹]\s*\d|\b\d+(?:[.,]\d+)?\s*(?:usd|eur|gbp|inr|dollars?|euros?|pounds?|rupees?)\b|\b(?:starts?|starting)\s+(?:at|from)\s+\d|\b(?:plan|tier|package)\b.{0,50}\b(?:starts?|starting|from|at)\s+(?:at\s+)?\d)/i;
const caveat = 'Pricing may depend on the plan, currency, billing period, number of seats, region, and taxes; verify any details not shown in the cited source.';

/** Conservatively qualify price passages and answers to explicit pricing questions. */
export function qualifyPriceClaim(claim: string, pricingQuestion = false): string {
  return pricingQuestion || priceLanguage.test(claim) ? `${claim} ${caveat}` : claim;
}

export function isPricingQuestion(input: string): boolean {
  return priceLanguage.test(input);
}

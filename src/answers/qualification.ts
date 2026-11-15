/** Keep price dimensions visible even when a provider snippet omits them. */
export function qualifyPriceClaim(claim: string): string {
  if (!/(?:\b(?:price|pricing|cost|fee|subscription|per month|per year)\b|[$€£₹]\s*\d|\b\d+(?:\.\d+)?\s*(?:usd|eur|gbp|inr)\b)/i.test(claim)) return claim;
  return `${claim} Pricing may depend on the plan, currency, billing period, number of seats, region, and taxes; verify any details not shown in the cited source.`;
}

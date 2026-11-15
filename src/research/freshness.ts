/** Explicit recency language must not be answered as if an unchecked model response were current. */
export function requiresCurrentVerification(input: string): boolean {
  return /\b(today|tonight|now|currently|current|latest|recent(?:ly)?|up[ -]to[ -]date|as of|still (?:correct|accurate|true|available)|changed since|changes since|since (?:then|yesterday|last))\b/i.test(input);
}

export function freshnessNotice(observedAt: string[], now: Date, maxAgeMs = 24 * 60 * 60 * 1000) {
  if (!observedAt.length) throw new Error('No observations');
  const times = observedAt.map(value => Date.parse(value));
  if (times.some(value => !Number.isFinite(value) || value > now.getTime() + 60_000)) throw new Error('Invalid observation time');
  const oldest = Math.min(...times);
  return {
    asOf: new Date(oldest).toISOString(),
    stale: now.getTime() - oldest > maxAgeMs,
  };
}

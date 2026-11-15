/** Explicit recency language must not be answered as if an unchecked model response were current. */
export function requiresCurrentVerification(input: string): boolean {
  const explicit = /\b(today|tonight|now|currently|current|latest|recent(?:ly)?|up[ -]to[ -]date|as of|still (?:correct|accurate|true|available|valid)|changed since|changes since|since (?:then|yesterday|last)|this (?:week|month|year))\b/i;
  const changed = /\b(change[ds]?|chang(?:ing|es)|updates?|updated|released|shipped|launched|deprecated)\b/i;
  const implicitCurrent = /\b(how much (?:does|do|is|are|will)|what (?:does|do) .{0,60} cost|what (?:is|are) (?:the |their |its )?(?:current )?(?:price|pricing|cost|fees?|rates?)|have .{0,80} (?:increased|decreased|risen|fallen|changed)|is .{0,60} still (?:the same|offered|supported))\b/i;
  return explicit.test(input) || implicitCurrent.test(input) || (/\bsince\b/i.test(input) && changed.test(input));
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

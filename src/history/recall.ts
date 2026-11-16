import type { Store } from '../persistence/store.js';
import { interpretDateReference } from './date-reference.js';

/** Only exact-question recall is handled here; other references remain on the normal path. */
export async function prepareExactRecall(store: Store, owner: string, runId: string, input: string, recordedAt: Date, timezone: string): Promise<string | null> {
  if (!/\bwhat\s+(?:did|have)\s+i\s+(?:ask|say|asked|said)\b/i.test(input)) return null;
  if (/\b(?:today|tonight|now|currently|current|latest|recent|up[ -]to[ -]date|as of|correct|accurate|right|valid|still\s+true|same|changed?|change|since|verify|verified)\b/i.test(input)) return null;
  // A follow-up such as "Is your answer still correct today?" describes the
  // verification time, not the date of the original question.
  const date = interpretDateReference(input.split('?')[0], recordedAt, timezone);
  if (date.status === 'not_recognized') return 'Which date should I check? Please provide a date such as 3 November 2025.';
  if (date.status === 'clarification_needed') return date.reason;
  try {
    if (date.yearOmitted) {
      const [, month, day] = date.date.split('-').map(Number);
      const years = await store.recallYears(owner, runId, month, day);
      if (years.length > 1) return `I found questions on that date in multiple years (${years.slice(0, 5).join(', ')}${years.length > 5 ? ', and others' : ''}). Which year should I check?`;
      if (years.length === 1) {
        date.date = `${String(years[0]).padStart(4, '0')}-${date.date.slice(5)}`;
        date.interpretation = `The matching retained discussion in ${years[0]} in ${timezone}`;
      }
    }
    const id = await store.prepareDateRecall(owner, runId, date.date);
    const snapshot = await store.dateRecallSnapshot(owner, id, 0, 1);
    if (snapshot.coverage !== 'complete') return `I could not retrieve complete history for ${date.date} (${timezone}). Please try again.`;
    const limitation = /\b(correct|accurate|still|changed|current)\b/i.test(input)
      ? '\nThis lists the original questions only; I have not verified any earlier answer.' : '';
    if (snapshot.status === 'no_match') return `No retained questions found for ${date.date} (${timezone}). Interpretation: ${date.interpretation}.${limitation}`;
    return `Found ${snapshot.total} retained question${snapshot.total === 1 ? '' : 's'} for ${date.date} (${timezone}). Interpretation: ${date.interpretation}.${limitation}\n[recall:${id}]`;
  } catch {
    // A failed retrieval is not evidence that history is absent. Avoid leaking database errors.
    return `History retrieval failed for ${date.date} (${timezone}); I cannot determine whether there were matching questions. Please try again.`;
  }
}

import type { ReferenceCandidate, Store } from '../persistence/store.js';
import { interpretHistoricalRequest } from './reference.js';

export type HistoricalContextPreparation =
  | { kind: 'not_needed' }
  | { kind: 'resolved'; snapshotId: string; source: ReferenceCandidate; coverage: 'complete'; discussionDate: string | null; comparisonDate: string | null }
  | { kind: 'clarification_needed'; snapshotId: string; question: string }
  | { kind: 'no_match'; snapshotId: string }
  | { kind: 'incomplete'; snapshotId?: string };

function choiceNumber(input: string) {
  if (!/^(?:use\s+)?(?:the\s+)?(?:first|second|third|option\s+[1-3]|number\s+[1-3]|[1-3])(?:\s+one)?[.!\s]*$/i.test(input.trim())) return null;
  const number = /\b(1|2|3)\b/.exec(input)?.[1];
  if (number) return Number(number);
  return /\bfirst\b/i.test(input) ? 1 : /\bsecond\b/i.test(input) ? 2 : 3;
}

const dayLabel = (date: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));

export async function prepareHistoricalContext(store: Store, owner: string, runId: string, input: string, recordedAt: Date, timezone: string, continuity: string): Promise<HistoricalContextPreparation> {
  const request = interpretHistoricalRequest(input, recordedAt, timezone, continuity);
  const selectedNumber = choiceNumber(input);
  if (!request.needed && selectedNumber === null) return { kind: 'not_needed' };
  try {
    if (selectedNumber !== null) {
      const previous = await store.pendingReferenceSnapshot(owner, runId);
      if (!previous) return { kind: 'not_needed' };
      const snapshotId = await store.saveReferenceChoice(owner, runId, previous, selectedNumber);
      const snapshot = await store.referenceSnapshot(owner, snapshotId);
      const source = snapshot.items[0];
      return source ? { kind: 'resolved', snapshotId, source: { ...source, score: 0 }, coverage: 'complete', discussionDate: snapshot.discussion_date, comparisonDate: snapshot.comparison_date } : { kind: 'incomplete', snapshotId };
    }
    if (!request.needed) return { kind: 'not_needed' };
    const discussion = request.discussion;
    if (discussion.status === 'clarification_needed') {
      const id = await store.saveReferenceSnapshot(owner, runId, 'clarification_needed', 'complete', null, null, []);
      return { kind: 'clarification_needed', snapshotId: id, question: discussion.reason };
    }
    const comparison = request.comparison;
    if (comparison.status === 'clarification_needed') {
      const id = await store.saveReferenceSnapshot(owner, runId, 'clarification_needed', 'complete', null, null, []);
      return { kind: 'clarification_needed', snapshotId: id, question: `Which comparison date did you mean? ${comparison.reason}` };
    }
    const discussionDate = discussion.status === 'resolved' ? discussion.date : null;
    const comparisonDate = comparison.status === 'resolved' ? comparison.date : null;
    if (!request.terms.length && !discussionDate) {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'clarification_needed', 'complete', null, comparisonDate, []);
      return { kind: 'clarification_needed', snapshotId, question: 'Which earlier discussion do you mean? A topic, date, or source conversation will help me find it.' };
    }
    const run = await store.getRun(owner, runId);
    const found = await store.findReferenceCandidates(owner, runId, request.terms, discussionDate);
    if (found.truncated) {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'incomplete', 'incomplete', discussionDate, comparisonDate, found.candidates);
      return { kind: 'incomplete', snapshotId };
    }
    let candidates = found.candidates;
    if (!request.terms.length && discussionDate) {
      const dated = await store.findReferenceCandidates(owner, runId, [], discussionDate);
      candidates = dated.candidates;
    }
    if (!candidates.length) {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'no_match', 'complete', discussionDate, comparisonDate, []);
      return { kind: 'no_match', snapshotId };
    }
    const currentConversation = candidates.filter(candidate => candidate.conversation_id === run.conversation_id);
    const top = candidates[0];
    const localPreferred = !discussionDate && currentConversation.length === 1 && currentConversation[0].score >= top.score - 1;
    const chosen = localPreferred ? currentConversation[0] : top;
    const competing = candidates.filter(candidate => candidate.id !== chosen.id && candidate.score >= chosen.score - 1);
    if (competing.length) {
      const options = [chosen, ...competing].slice(0, 3);
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'clarification_needed', 'complete', discussionDate, comparisonDate, options);
      const lines = options.map((candidate, index) => `${index + 1}. ${candidate.conversation_title} · ${dayLabel(candidate.created_at.toISOString().slice(0, 10))} · ${candidate.content.slice(0, 180)}`).join('\n');
      return { kind: 'clarification_needed', snapshotId, question: `I found several plausible discussions. Which one should I use? Reply with a number.\n${lines}` };
    }
    const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'resolved', 'complete', discussionDate, comparisonDate, [chosen]);
    return { kind: 'resolved', snapshotId, source: chosen, coverage: 'complete', discussionDate, comparisonDate };
  } catch {
    try {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'incomplete', 'incomplete', null, null, []);
      return { kind: 'incomplete', snapshotId };
    } catch { return { kind: 'incomplete' }; }
  }
}

export function historicalContextPrompt(source: ReferenceCandidate, coverage: 'complete', discussionDate: string | null, comparisonDate: string | null) {
  const recorded = new Date(source.created_at).toISOString();
  return `Authorized historical context, retrieved from original records. Coverage: ${coverage}. It establishes only what was said, not whether any claim was correct.\nSource conversation: ${source.conversation_title}, original question recorded ${recorded}.\nOriginal user message:\n${source.content}\nOriginal assistant response:\n${source.answer}\nTemporal interpretation: discussion date ${discussionDate || 'not specified'}; comparison interval anchor ${comparisonDate || 'not specified'}. Treat these dates independently and do not claim a historical price was verified unless the original includes evidence.`;
}


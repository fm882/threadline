import type { ReferenceCandidate, Store } from '../persistence/store.js';
import { interpretHistoricalRequest } from './reference.js';
import type { HistoryRetriever } from './index.js';

export type HistoricalContextPreparation =
  | { kind: 'not_needed' }
  | { kind: 'resolved'; snapshotId: string; source: ReferenceCandidate; coverage: 'complete' | 'incomplete'; discussionDate: string | null; comparisonDate: string | null }
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

export async function prepareHistoricalContext(store: Store, owner: string, runId: string, input: string, recordedAt: Date, timezone: string, continuity: string, retrieve?: HistoryRetriever): Promise<HistoricalContextPreparation> {
  const request = interpretHistoricalRequest(input, recordedAt, timezone, continuity);
  if (/\bwhat\s+(?:did|have)\s+i\s+(?:ask|say|asked|said)\b/i.test(input) && request.discussion.status === 'resolved') request.terms = [];
  const selectedNumber = choiceNumber(input);
  if (!request.needed && selectedNumber === null) return { kind: 'not_needed' };
  try {
    if (selectedNumber !== null) {
      const previous = await store.pendingReferenceSnapshot(owner, runId);
      if (!previous) return { kind: 'not_needed' };
      const snapshotId = await store.saveReferenceChoice(owner, runId, previous, selectedNumber);
      const snapshot = await store.referenceSnapshot(owner, snapshotId);
      const source = snapshot.items[0];
      return source ? { kind: 'resolved', snapshotId, source: { ...source, score: 0 }, coverage: snapshot.coverage === 'complete' ? 'complete' : 'incomplete', discussionDate: snapshot.discussion_date, comparisonDate: snapshot.comparison_date } : { kind: 'incomplete', snapshotId };
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
    const found = retrieve ? await retrieve(owner, runId, request.terms, discussionDate, `${input}\n${continuity}`) : { ...(await store.findReferenceCandidates(owner, runId, request.terms, discussionDate)), coverage: 'complete' as const };
    if (found.truncated) {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'incomplete', 'incomplete', discussionDate, comparisonDate, found.candidates);
      return { kind: 'incomplete', snapshotId };
    }
    let candidates = found.candidates;
    if (!request.terms.length && discussionDate) {
      const dated = retrieve ? await retrieve(owner, runId, [], discussionDate, `${input}\n${continuity}`) : { ...(await store.findReferenceCandidates(owner, runId, [], discussionDate)), coverage: 'complete' as const };
      candidates = dated.candidates;
    }
    if (!candidates.length) {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, found.coverage === 'complete' ? 'no_match' : 'incomplete', found.coverage, discussionDate, comparisonDate, []);
      return found.coverage === 'complete' ? { kind: 'no_match', snapshotId } : { kind: 'incomplete', snapshotId };
    }
    const currentConversation = candidates.filter(candidate => candidate.conversation_id === run.conversation_id);
    const top = candidates[0];
    const localPreferred = !discussionDate && currentConversation.length === 1 && currentConversation[0].score >= top.score - 1;
    const chosen = localPreferred ? currentConversation[0] : top;
    const competing = candidates.filter(candidate => candidate.id !== chosen.id && candidate.score >= chosen.score - 1);
    if (competing.length) {
      const options = [chosen, ...competing].slice(0, 3);
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'clarification_needed', found.coverage, discussionDate, comparisonDate, options);
      const lines = options.map((candidate, index) => `${index + 1}. ${candidate.conversation_title} · ${dayLabel(candidate.created_at.toISOString().slice(0, 10))} · ${candidate.content.slice(0, 180)}`).join('\n');
      return { kind: 'clarification_needed', snapshotId, question: `I found several plausible discussions. Which one should I use? Reply with a number.\n${lines}` };
    }
    const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'resolved', found.coverage, discussionDate, comparisonDate, [chosen]);
    return { kind: 'resolved', snapshotId, source: chosen, coverage: found.coverage, discussionDate, comparisonDate };
  } catch {
    try {
      const snapshotId = await store.saveReferenceSnapshot(owner, runId, 'incomplete', 'incomplete', null, null, []);
      return { kind: 'incomplete', snapshotId };
    } catch { return { kind: 'incomplete' }; }
  }
}

export function historicalContextPrompt(source: ReferenceCandidate, coverage: 'complete' | 'incomplete', discussionDate: string | null, comparisonDate: string | null) {
  const supportedThen = 'historical_claims' in source && Array.isArray(source.historical_claims)
    ? source.historical_claims as { claim: string; evidence: { id: string; title: string; url: string; excerpt: string; observed_at: Date }[] }[] : [];
  const corrections = 'corrections' in source && Array.isArray(source.corrections)
    ? source.corrections as { correction: string; created_at: Date }[] : [];
  const historicalSources = supportedThen.length ? supportedThen.map(item => `${item.claim}\n${item.evidence.map(evidence => `- ${evidence.title} (${new Date(evidence.observed_at).toISOString()}) [historical source:${evidence.id}]: ${evidence.excerpt} [${evidence.url}]`).join('\n')}`).join('\n\n') : 'No cited source observations were attached to the original answer.';
  const recorded = new Date(source.created_at).toISOString();
  const correctionsText = corrections.length ? corrections.map(item => `- (${new Date(item.created_at).toISOString()}) ${item.correction}`).join('\n') : 'No appended corrections are recorded.';
  return `Authorized historical context, retrieved from original records. Coverage: ${coverage}. It establishes only what was said, not whether any claim was correct.${coverage === 'incomplete' ? ' Retrieval coverage is incomplete; treat this as a partial candidate and do not infer absence or completeness from it.' : ''}\nSource conversation: ${source.conversation_title}, original question recorded ${recorded}.\nOriginal user message:\n${source.content}\nOriginal assistant response (preserve this wording as the recorded answer):\n${source.answer}\nSources attached to that answer at the time (${supportedThen.reduce((count, claim) => count + claim.evidence.length, 0)} observations):\n${historicalSources}\nCorrections appended later (these do not rewrite the original):\n${correctionsText}\nFor a comparison, distinguish: what was said; what the attached sources supported then; and what current evidence supports now. Missing attached evidence is not proof the old answer was wrong or that the offer changed. If no historical sources were attached, a current finding is allowed but a historical change or prior-error claim is not established.\nTemporal interpretation: discussion date ${discussionDate || 'not specified'}; comparison interval anchor ${comparisonDate || 'not specified'}. Treat these dates independently and do not claim a historical price was verified unless the original includes evidence.`;
}


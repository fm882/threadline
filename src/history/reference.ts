import { interpretDateReference, type DateReference } from './date-reference.js';

export type HistoricalRequest = {
  needed: boolean;
  terms: string[];
  discussion: DateReference;
  comparison: DateReference;
};

const stops = new Set('about after all any are around asked been between changed choose considered did discussion do five from had has have here how i in is it list me monday much my of on one or our over price pricing really same since shortlist shortlisted that the them then these those today tools we what which with'.split(' '));

/** Separates a date locating the discussion from a date describing the comparison period. */
export function interpretHistoricalRequest(input: string, recordedAt: Date, timezone: string, continuity = ''): HistoricalRequest {
  const dateExpression = '((?:last\\s+)?(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:\\d{4}-\\d{2}-\\d{2})|(?:\\d{1,2}(?:st|nd|rd|th)?\\s+[a-z]{3,9}(?:\\s+\\d{4})?)|(?:[a-z]{3,9}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?))';
  const discussionClause = new RegExp(`\\b(?:on|from|around|when)\\s+${dateExpression}`, 'i').exec(input)
    || new RegExp(`^\\s*${dateExpression}`, 'i').exec(input);
  const comparisonClause = /\b(?:since|after|over\s+the\s+last|in\s+the\s+last)\s+((?:last\s+)?(?:today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|(?:\d{4}-\d{2}-\d{2})|(?:\d{1,2}(?:st|nd|rd|th)?\s+[a-z]{3,9}(?:\s+\d{4})?)|(?:[a-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?))/i.exec(input);
  const discussion = discussionClause ? interpretDateReference(discussionClause[1], recordedAt, timezone) : { status: 'not_recognized' as const };
  const comparison = comparisonClause ? interpretDateReference(comparisonClause[1], recordedAt, timezone) : { status: 'not_recognized' as const };
  const historyPattern = /\b(?:discussed|talked\s+about|asked|said|mentioned|recommended|suggested|those\s+(?:five|ones|tools|products)|these\s+(?:five|ones|tools|products)|that\s+(?:shortlist|list|discussion)|the\s+list|same\s+(?:five|ones|tools|products)|any\s+of\s+them|what\s+about\s+those|what\s+was\s+the\s+shortlist|earlier|previous(?:ly)?|last\s+time)\b/i;
  const shortlistFollowup = /\bshortlist(?:ed)?\b/i.test(input) && /\b(?:what|changed|since|them|those|same|earlier|previous)\b/i.test(input);
  const historySignal = historyPattern.test(input) || shortlistFollowup || (historyPattern.test(continuity) && /\b(?:they|them|those|these|that|same|it)\b/i.test(input));
  const anaphoric = /\b(?:they|them|those|these|that|same|it|one|ones)\b/i.test(input);
  const searchText = anaphoric ? `${input} ${continuity}` : input;
  const terms = [...new Set(searchText.toLowerCase().replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').match(/[a-z0-9][a-z0-9+#.-]{1,}/g) || [])]
    .filter(term => !stops.has(term) && !/^(?:19|20)\d\d$/.test(term) && !/^\d+$/.test(term) && !/^(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*$/.test(term) && !/^(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*$/.test(term)).slice(-30);
  return { needed: historySignal, terms, discussion, comparison };
}


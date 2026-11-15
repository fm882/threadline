export type DateReference =
  | { status: 'resolved'; date: string; interpretation: string; yearOmitted?: boolean }
  | { status: 'clarification_needed'; reason: string }
  | { status: 'not_recognized' };

const months = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** Interpret a date relative to the recorded instant, in the run's frozen timezone. */
export function interpretDateReference(text: string, recordedAt: Date, timezone: string): DateReference {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(recordedAt);
  const value = (type: string) => Number(parts.find(part => part.type === type)?.value);
  const localYear = value('year'), localMonth = value('month'), localDay = value('day');
  const today = new Date(Date.UTC(localYear, localMonth - 1, localDay));
  const namedPattern = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?\b/gi;
  const monthFirstPattern = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi;
  const namedDates = [...text.matchAll(namedPattern)];
  const monthFirstDates = [...text.matchAll(monthFirstPattern)].filter(candidate => !namedDates.some(date => candidate.index! < date.index! + date[0].length && date.index! < candidate.index! + candidate[0].length));
  const isoDates = [...text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)];
  const relativeDates = [...text.matchAll(/\b(today|yesterday|(?:last\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))\b/gi)];
  if (/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(text)) return { status: 'clarification_needed', reason: 'Numeric dates can be ambiguous. Please provide the month by name or use YYYY-MM-DD.' };
  if (namedDates.length + monthFirstDates.length + isoDates.length + relativeDates.length > 1) return { status: 'clarification_needed', reason: 'More than one date was mentioned. Which date should I check?' };
  const relative = /\b(today|yesterday)\b/i.exec(text);
  if (relative) {
    if (relative[1].toLowerCase() === 'yesterday') today.setUTCDate(today.getUTCDate() - 1);
    return { status: 'resolved', date: today.toISOString().slice(0, 10), interpretation: `${relative[1].toLowerCase()} relative to the recorded time in ${timezone}` };
  }
  const weekday = /\b(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.exec(text);
  if (weekday) {
    const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    let difference = (today.getUTCDay() - days.indexOf(weekday[2].toLowerCase()) + 7) % 7;
    if (difference === 0) difference = 7;
    today.setUTCDate(today.getUTCDate() - difference);
    return { status: 'resolved', date: today.toISOString().slice(0, 10), interpretation: `Most recent past ${weekday[2]} relative to the recorded time in ${timezone}` };
  }
  const iso = isoDates[0];
  const monthFirst = monthFirstDates[0];
  const named = namedDates[0] || (monthFirst ? [monthFirst[0], monthFirst[2], monthFirst[1], monthFirst[3]] : undefined);
  if (!iso && !named) return { status: 'not_recognized' };
  let year = iso ? Number(iso[1]) : named![3] ? Number(named![3]) : localYear;
  const month = iso ? Number(iso[2]) : months.findIndex(name => name.startsWith(named![2].toLowerCase())) + 1;
  const day = iso ? Number(iso[3]) : Number(named![1]);
  if (!iso && !named![3] && (month > localMonth || (month === localMonth && day > localDay))) year--;
  if (!iso && !named![3] && month === 2 && day === 29) {
    while (year > 1 && !(year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0))) year--;
  }
  const date = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const checked = new Date(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(checked.getTime()) || checked.toISOString().slice(0, 10) !== date) return { status: 'clarification_needed', reason: 'That date is invalid. Please provide a valid date.' };
  return { status: 'resolved', date, interpretation: !iso && !named![3] ? `Most recent past ${named![1]} ${named![2]} in ${timezone}` : `Explicit date in ${timezone}`, yearOmitted: !iso && !named![3] };
}

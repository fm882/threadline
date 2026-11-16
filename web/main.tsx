import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Message = { id: string; role: string; content: string; ordinal: number; citation_ids: string[]; run_id?: string | null; run_status?: string | null; recall_snapshot_id?: string | null; reference_snapshot_id?: string | null; reference_coverage?: 'complete' | 'incomplete' | null };
type Conversation = { id: string; created_at: string; recall_eligible: boolean };
type Evidence = { id: string; url: string; title: string; excerpt: string; observed_at: string; provider: string; representation: string };
type RecallPage = { id: string; date: string; timezone: string; total: number; coverage: string; next: number | null; messages: { id: string; conversation_id: string; content: string; created_at: string; relative_date?: { status: string; date?: string; timezone: string | null } | null }[] };
type ReferencePage = { id: string; status: string; coverage: string; discussion_date: string | null; comparison_date: string | null; items: { id: string; conversation_id: string; conversation_title: string; content: string; answer: string; created_at: string; rank: number; historical_claims: { claim: string; evidence: { id: string; title: string; url: string; excerpt: string; observed_at: string }[] }[]; corrections: { id: string; correction: string; created_at: string }[] }[] };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data as T;
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversation, setConversation] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [timezoneSource, setTimezoneSource] = useState('fallback');
  const [recallEligible, setRecallEligible] = useState(true);
  const [verifyCurrent, setVerifyCurrent] = useState(false);
  const [streamed, setStreamed] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeRun, setActiveRun] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('Working on it…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState('Checking connection…');
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const [recall, setRecall] = useState<RecallPage | null>(null);
  const [reference, setReference] = useState<ReferencePage | null>(null);
  const source = useRef<EventSource | null>(null);
  const activeRunRef = useRef('');
  const sending = useRef(false);
  const selected = useRef('');
  const pending = useRef<{ conversation: string; input: string; key: string; verifyCurrent: boolean } | null>(null);

  async function list() { const data = await api<{ conversations: Conversation[] }>('/api/conversations'); setConversations(data.conversations); }
  async function history(id: string) {
    const all: Message[] = []; let after = 0;
    while (true) {
      const page = await api<{ messages: Message[] }>(`/api/conversations/${id}/messages?after=${after}`);
      all.push(...page.messages);
      if (page.messages.length < 50) break;
      after = page.messages[page.messages.length - 1].ordinal;
    }
    if (selected.current === id) setMessages(all);
  }
  async function select(id: string) {
    selected.current = id; setConversation(id); setMessages([]); setStreamed(''); setError('');
    try {
      let detected = 'UTC'; let fallback = false;
      try { detected = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; fallback = !Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { fallback = true; }
      const preference = await api<{ timezone: string; timezone_source: string; recall_eligible: boolean }>(`/api/conversations/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone: detected, initialize: true, fallback }) });
      if (selected.current !== id) return;
      setTimezone(preference.timezone); setTimezoneSource(preference.timezone_source);
      setRecallEligible(preference.recall_eligible);
      await history(id);
      const { runId } = await api<{ runId: string | null }>(`/api/conversations/${id}/active-run`);
      if (selected.current !== id) return;
      if (runId) { setBusy(true); setProgress('Reconnecting to the run…'); activeRunRef.current = runId; setActiveRun(runId); watchRun(id, runId); }
      else await history(id);
    } catch (e) { setError((e as Error).message); }
  }
  async function create() {
    try { const data = await api<{ id: string }>('/api/conversations', { method: 'POST' }); await list(); await select(data.id); }
    catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    void list().catch(e => setError(e.message));
    const check = () => { void api<{ status: string }>('/health/ready').then(() => setReady('Ready')).catch(e => setReady(e.message)); };
    check(); const timer = setInterval(check, 10000);
    return () => { clearInterval(timer); source.current?.close(); };
  }, []);
  async function saveTimezone() {
    try { const preference = await api<{ timezone: string; timezone_source: string }>(`/api/conversations/${conversation}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ timezone }) }); setTimezone(preference.timezone); setTimezoneSource(preference.timezone_source); setNotice('Timezone saved for future turns.'); } catch (e) { setError((e as Error).message); }
  }
  async function saveRecallEligibility(value: boolean) {
    try { const result = await api<{ recall_eligible: boolean }>(`/api/conversations/${conversation}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recallEligible: value }) }); setRecallEligible(result.recall_eligible); setNotice(value ? 'This conversation may be used for future history references.' : 'This conversation is excluded from automatic history references.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function deleteCurrentConversation() {
    if (!conversation || !window.confirm('Delete this conversation and its dependent history? This cannot be undone.')) return;
    const id = conversation;
    try { await api(`/api/conversations/${id}`, { method: 'DELETE' }); source.current?.close(); source.current = null; activeRunRef.current = ''; setActiveRun(''); setBusy(false); selected.current = ''; setConversation(''); setMessages([]); setRecall(null); setReference(null); await list(); setNotice('Conversation deleted.'); }
    catch (e) { setError((e as Error).message); }
  }
  async function inspect(id: string) {
    try { setEvidence(await api<Evidence>(`/api/evidence/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  async function loadRecall(id: string, after = 0) {
    try {
      const page = await api<RecallPage>(`/api/history/${id}?after=${after}`);
      setRecall(previous => after && previous?.id === id ? { ...page, messages: [...previous.messages, ...page.messages] } : page);
    } catch (e) { setError((e as Error).message); }
  }
  async function loadReference(id: string) {
    try { setReference(await api<ReferencePage>(`/api/references/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  function renderContent(content: string, citationIds: string[], recallId?: string | null, referenceId?: string | null, referenceCoverage?: string | null) {
    return content.split(/(\[(?:source|recall|reference):[0-9a-f-]{36}\])/gi).map((part, index) => {
      const match = /^\[source:([0-9a-f-]{36})\]$/i.exec(part);
      const recallMatch = /^\[recall:([0-9a-f-]{36})\]$/i.exec(part);
      const referenceMatch = /^\[reference:([0-9a-f-]{36})\]$/i.exec(part);
      if (recallMatch && recallMatch[1] === recallId) return <button className="citation" key={index} onClick={() => void loadRecall(recallId)}>View original questions</button>;
      if (referenceMatch && referenceMatch[1] === referenceId) return <span key={index}><button className="citation" data-reference-id={referenceId} onClick={() => void loadReference(referenceId)}>View discussion source</button>{referenceCoverage === 'incomplete' && <small role="status"> Historical coverage is incomplete.</small>}</span>;
      return match && citationIds.includes(match[1]) ? <button className="citation" key={index} onClick={() => void inspect(match[1])}>Source</button> : part;
    });
  }
  function watchRun(id: string, runId: string) {
    const events = new EventSource(`/api/runs/${runId}/events`); source.current = events;
    const current = () => activeRunRef.current === runId;
    const terminal = () => { events.close(); if (source.current === events) source.current = null; activeRunRef.current = ''; setStreamed(''); setBusy(false); setActiveRun(''); };
    events.addEventListener('reset', () => { if (current()) { setStreamed(''); setProgress('Reconnecting to the run…'); } });
    events.addEventListener('progress', event => { if (!current()) return; const stage = JSON.parse((event as MessageEvent).data).stage; setProgress(stage === 'searching' ? 'Searching the web…' : 'Reviewing sources…'); });
    events.addEventListener('delta', event => { if (current()) setStreamed(value => value + JSON.parse((event as MessageEvent).data).content); });
    events.addEventListener('completed', () => { if (!current()) return; terminal(); setError(''); void history(id).catch(e => setError(e.message)); });
    events.addEventListener('incomplete', () => { if (!current()) return; terminal(); setNotice('Research timed out before a verified answer was ready. Continue with a fresh time limit.'); void history(id).catch(e => setError(e.message)); });
    events.addEventListener('failed', event => { if (!current()) return; terminal(); setError(JSON.parse((event as MessageEvent).data).message); void history(id).catch(e => setError(e.message)); });
    events.addEventListener('cancelled', () => { if (!current()) return; terminal(); setError(''); setNotice('Run stopped.'); void history(id).catch(e => setError(e.message)); });
    events.onerror = () => { if (current()) setError('Connection interrupted. Reconnecting to the run…'); };
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || !conversation || sending.current) return;
    const id = conversation, input = draft, fresh = verifyCurrent;
    sending.current = true;
    try {
      if (busy) {
        const previous = activeRunRef.current;
        if (!previous) return;
        const result = await api<{ status: string }>(`/api/runs/${previous}/cancel`, { method: 'POST' });
        if (!['cancelled', 'completed', 'failed'].includes(result.status)) throw new Error('The previous run is still active.');
        activeRunRef.current = ''; source.current?.close(); source.current = null;
        setActiveRun(''); setStreamed('');
      }
      const attempt = pending.current && pending.current.conversation === id && pending.current.input === input && pending.current.verifyCurrent === fresh ? pending.current : { conversation: id, input, verifyCurrent: fresh, key: crypto.randomUUID() };
      pending.current = attempt;
      setBusy(true); setProgress('Working on it…'); setNotice(''); setError(''); setStreamed('');
      const result = await api<{ runId: string }>(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key }, body: JSON.stringify({ input, verifyCurrent: attempt.verifyCurrent }) });
      pending.current = null; activeRunRef.current = result.runId; setActiveRun(result.runId); setDraft('');
      void history(id).catch(e => setError(e.message));
      watchRun(id, result.runId);
    } catch (e) { setError((e as Error).message); if (!activeRunRef.current) setBusy(false); }
    finally { sending.current = false; }
  }
  async function stop() {
    if (!activeRun) return;
    try {
      const result = await api<{ status: string }>(`/api/runs/${activeRun}/cancel`, { method: 'POST' });
      if (result.status === 'completed') setNotice('The response completed before it could be stopped.');
      else if (result.status === 'cancelled') {
        activeRunRef.current = ''; source.current?.close(); source.current = null; setBusy(false); setActiveRun(''); setStreamed(''); setError(''); setNotice('Run stopped.');
        await history(conversation);
      }
      else setNotice(`Run status: ${result.status}.`);
    } catch (e) { setError((e as Error).message); }
  }
  async function continueResearch(runId: string) {
    const key = crypto.randomUUID();
    setBusy(true); setError(''); setNotice('Continuing with a fresh research time limit…'); setStreamed('');
    try {
      const result = await api<{ runId: string }>(`/api/runs/${runId}/continue`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify({}) });
      activeRunRef.current = result.runId; setActiveRun(result.runId); watchRun(conversation, result.runId);
    } catch (e) { setBusy(false); setNotice(''); setError((e as Error).message); }
  }
  return <div className="app"><aside><div className="brand">Research chat</div><button className="new" onClick={() => void create()} disabled={busy}>+ New conversation</button><h2>Conversations</h2><nav aria-label="Conversations">{conversations.map((item, i) => <button key={item.id} disabled={busy} className={conversation === item.id ? 'selected' : ''} onClick={() => void select(item.id)}>Conversation {conversations.length - i}<small>{new Date(item.created_at).toLocaleDateString()}</small></button>)}</nav><p className="status"><span className={ready === 'Ready' ? 'dot good' : 'dot'} />{ready}</p></aside><main><header><div><h1>{conversation ? 'Conversation' : 'Start a conversation'}</h1><p>Your conversations are stored locally.</p>{conversation && <><div><label htmlFor="timezone">Timezone</label> <input id="timezone" value={timezone} onChange={event => setTimezone(event.target.value)} disabled={busy} /> <button type="button" onClick={() => void saveTimezone()} disabled={busy}>Save</button>{timezoneSource === 'fallback' && <small> UTC fallback: browser timezone unavailable.</small>}</div><label><input type="checkbox" checked={recallEligible} disabled={busy} onChange={event => void saveRecallEligibility(event.target.checked)} /> Allow this conversation in automatic history references</label> <button type="button" onClick={() => void deleteCurrentConversation()}>Delete conversation</button></>}</div></header><section className="transcript" aria-label="Conversation messages" aria-live="polite">{!conversation ? <div className="empty"><h2>What would you like to explore?</h2><p>Create a conversation to get started.</p><button onClick={() => void create()}>New conversation</button></div> : messages.length === 0 ? <div className="empty"><h2>Start with a question</h2><p>Send a message below to begin.</p></div> : messages.map(message => <article key={message.id} className={message.role}><div className="speaker">{message.role === 'user' ? 'You' : 'Assistant'}</div><div className="content">{renderContent(message.content, message.citation_ids || [], message.recall_snapshot_id, message.reference_snapshot_id, message.reference_coverage)}</div>{message.role === 'assistant' && message.run_status === 'incomplete' && message.run_id && <button type="button" onClick={() => void continueResearch(message.run_id!)}>Continue research</button>}</article>)}{streamed && <article className="assistant"><div className="speaker">Assistant</div><div className="content">{streamed}</div></article>}{busy && !streamed && <p className="working">{progress}</p>}</section>{recall && <section className="evidence" aria-label="Original questions"><button className="close" onClick={() => setRecall(null)} aria-label="Close original questions">×</button><h2>Original questions</h2><p>{recall.date} · {recall.timezone} · {recall.total} total · {recall.coverage}</p>{recall.messages.map(item => <article key={item.id}><div className="content">{item.content}</div>{item.relative_date && <p>Relative date in the original message: {item.relative_date.status === 'resolved' ? `${item.relative_date.date} (${item.relative_date.timezone})` : item.relative_date.status === 'timezone_unavailable' ? 'original timezone unavailable' : 'needs clarification'}</p>}<small>{new Date(item.created_at).toLocaleString()} · </small><button className="citation" onClick={() => { setRecall(null); void select(item.conversation_id); }}>Open conversation</button></article>)}{recall.next !== null && <button onClick={() => void loadRecall(recall.id, recall.next!)}>Load more</button>}</section>}{reference && <section className="evidence" aria-label="Historical discussion"><button className="close" onClick={() => setReference(null)} aria-label="Close historical discussion">×</button><h2>{reference.status === 'clarification_needed' ? 'Possible discussions' : 'Historical discussion'}</h2><p>Coverage: {reference.coverage}{reference.discussion_date ? ` · Discussion date ${reference.discussion_date}` : ''}{reference.comparison_date ? ` · Comparison interval ${reference.comparison_date}` : ''}</p>{reference.items.map(item => <article key={item.id}><strong>{item.conversation_title}</strong><p>{new Date(item.created_at).toLocaleString()}</p><div className="content">You asked: {item.content}</div>{item.answer && <blockquote>Assistant replied: {item.answer}</blockquote>}{item.historical_claims.length > 0 ? <section aria-label="Sources cited then"><strong>Sources cited then</strong>{item.historical_claims.map((claim, claimIndex) => <article key={`${item.id}-claim-${claimIndex}`}><p>{claim.claim}</p>{claim.evidence.map(source => <blockquote key={source.id}><strong>{source.title}</strong><small>Observed {new Date(source.observed_at).toLocaleString()}</small><p>{source.excerpt}</p>{/^https?:\/\//i.test(source.url) && <a href={source.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}</blockquote>)}</article>)}</section> : item.answer && <p>No cited source observations were stored for this answer.</p>}{item.corrections.length > 0 && <section aria-label="Corrections recorded later"><strong>Corrections recorded later</strong>{item.corrections.map(correction => <blockquote key={correction.id}><small>{new Date(correction.created_at).toLocaleString()}</small><p>{correction.correction}</p></blockquote>)}</section>}<button className="citation" onClick={() => { setReference(null); void select(item.conversation_id); }}>Open source conversation</button>{reference.status === 'clarification_needed' && <button className="citation" onClick={() => { setDraft(`Use option ${item.rank}`); setNotice(`Option ${item.rank} is ready to send.`); }}>Use option {item.rank}</button>}</article>)}</section>}{evidence && <section className="evidence" aria-label="Source details"><button className="close" onClick={() => setEvidence(null)} aria-label="Close source details">×</button><h2>Source details</h2><strong>{evidence.title}</strong><p>Observed {new Date(evidence.observed_at).toLocaleString()} · {evidence.provider} · search snippet</p><blockquote>{evidence.excerpt}</blockquote>{/^https?:\/\//i.test(evidence.url) && <a href={evidence.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}</section>}<div className="composer">{notice && <p role="status">{notice}</p>}{busy && activeRun && <button className="stop" onClick={() => void stop()}>Stop response</button>}{error && <p className="error" role="alert">{error}</p>}<form onSubmit={event => void send(event)}><label className="sr-only" htmlFor="message">Your message</label><textarea id="message" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask a question…" maxLength={8000} disabled={!conversation} rows={3} /><button type="submit" disabled={!conversation || (busy && !activeRun) || !draft.trim()}>{busy ? 'Stop and send' : 'Send'} <span aria-hidden="true">↑</span></button></form><label className="verify"><input type="checkbox" checked={verifyCurrent} disabled={busy} onChange={event => setVerifyCurrent(event.target.checked)} /> Verify current information with fresh search</label><p>Responses can be inaccurate. Check important information.</p></div></main></div>;
}

createRoot(document.getElementById('root')!).render(<App />);

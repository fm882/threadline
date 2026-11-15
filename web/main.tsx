import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

type Message = { id: string; role: string; content: string; ordinal: number; citation_ids: string[] };
type Conversation = { id: string; created_at: string };
type Evidence = { id: string; url: string; title: string; excerpt: string; observed_at: string; provider: string; representation: string };

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
  const [verifyCurrent, setVerifyCurrent] = useState(false);
  const [streamed, setStreamed] = useState('');
  const [busy, setBusy] = useState(false);
  const [activeRun, setActiveRun] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState('Working on it…');
  const [error, setError] = useState('');
  const [ready, setReady] = useState('Checking connection…');
  const [evidence, setEvidence] = useState<Evidence | null>(null);
  const source = useRef<EventSource | null>(null);
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
    try { await history(id); } catch (e) { setError((e as Error).message); }
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
  async function inspect(id: string) {
    try { setEvidence(await api<Evidence>(`/api/evidence/${id}`)); } catch (e) { setError((e as Error).message); }
  }
  function renderContent(content: string, citationIds: string[]) {
    return content.split(/(\[source:[0-9a-f-]{36}\])/gi).map((part, index) => {
      const match = /^\[source:([0-9a-f-]{36})\]$/i.exec(part);
      return match && citationIds.includes(match[1]) ? <button className="citation" key={index} onClick={() => void inspect(match[1])}>Source</button> : part;
    });
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    if (!draft.trim() || busy) return;
    const id = conversation;
    if (!id) return;
    const input = draft;
    const attempt = pending.current && pending.current.conversation === id && pending.current.input === input && pending.current.verifyCurrent === verifyCurrent ? pending.current : { conversation: id, input, verifyCurrent, key: crypto.randomUUID() };
    pending.current = attempt;
    setBusy(true); setProgress('Working on it…'); setNotice(''); setError(''); setStreamed('');
    try {
      const result = await api<{ runId: string }>(`/api/conversations/${id}/turns`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key }, body: JSON.stringify({ input, verifyCurrent: attempt.verifyCurrent }) });
      pending.current = null; setActiveRun(result.runId); setDraft(''); await history(id);
      const events = new EventSource(`/api/runs/${result.runId}/events`); source.current = events;
      events.addEventListener('progress', event => { const stage = JSON.parse((event as MessageEvent).data).stage; setProgress(stage === 'searching' ? 'Searching the web…' : 'Reviewing sources…'); });
      events.addEventListener('delta', event => setStreamed(value => value + JSON.parse((event as MessageEvent).data).content));
      events.addEventListener('completed', () => { events.close(); source.current = null; setStreamed(''); setBusy(false); setActiveRun(''); setError(''); void history(id).catch(e => setError(e.message)); });
      events.addEventListener('failed', event => { events.close(); source.current = null; setStreamed(''); setBusy(false); setActiveRun(''); setError(JSON.parse((event as MessageEvent).data).message); void history(id).catch(e => setError(e.message)); });
      events.addEventListener('cancelled', () => { events.close(); source.current = null; setStreamed(''); setBusy(false); setActiveRun(''); setError(''); setNotice('Run stopped.'); void history(id).catch(e => setError(e.message)); });
      events.onerror = () => { setError('Connection interrupted. Reconnecting to the run…'); };
    } catch (e) { setError((e as Error).message); setBusy(false); }
  }
  async function stop() {
    if (!activeRun) return;
    try {
      const result = await api<{ status: string }>(`/api/runs/${activeRun}/cancel`, { method: 'POST' });
      if (result.status === 'completed') setNotice('The response completed before it could be stopped.');
      else if (result.status === 'cancelled') setNotice('Stopping the run…');
      else setNotice(`Run status: ${result.status}.`);
    } catch (e) { setError((e as Error).message); }
  }
  return <div className="app"><aside><div className="brand">Research chat</div><button className="new" onClick={() => void create()} disabled={busy}>+ New conversation</button><h2>Conversations</h2><nav aria-label="Conversations">{conversations.map((item, i) => <button key={item.id} disabled={busy} className={conversation === item.id ? 'selected' : ''} onClick={() => void select(item.id)}>Conversation {conversations.length - i}<small>{new Date(item.created_at).toLocaleDateString()}</small></button>)}</nav><p className="status"><span className={ready === 'Ready' ? 'dot good' : 'dot'} />{ready}</p></aside><main><header><div><h1>{conversation ? 'Conversation' : 'Start a conversation'}</h1><p>Your conversations are stored locally.</p></div></header><section className="transcript" aria-label="Conversation messages" aria-live="polite">{!conversation ? <div className="empty"><h2>What would you like to explore?</h2><p>Create a conversation to get started.</p><button onClick={() => void create()}>New conversation</button></div> : messages.length === 0 ? <div className="empty"><h2>Start with a question</h2><p>Send a message below to begin.</p></div> : messages.map(message => <article key={message.id} className={message.role}><div className="speaker">{message.role === 'user' ? 'You' : 'Assistant'}</div><div className="content">{renderContent(message.content, message.citation_ids || [])}</div></article>)}{streamed && <article className="assistant"><div className="speaker">Assistant</div><div className="content">{streamed}</div></article>}{busy && !streamed && <p className="working">{progress}</p>}</section>{evidence && <section className="evidence" aria-label="Source details"><button className="close" onClick={() => setEvidence(null)} aria-label="Close source details">×</button><h2>Source details</h2><strong>{evidence.title}</strong><p>Observed {new Date(evidence.observed_at).toLocaleString()} · {evidence.provider} · search snippet</p><blockquote>{evidence.excerpt}</blockquote>{/^https?:\/\//i.test(evidence.url) && <a href={evidence.url} target="_blank" rel="noopener noreferrer">Open source ↗</a>}</section>}<div className="composer">{notice && <p role="status">{notice}</p>}{busy && activeRun && <button className="stop" onClick={() => void stop()}>Stop response</button>}{error && <p className="error" role="alert">{error}</p>}<form onSubmit={event => void send(event)}><label className="sr-only" htmlFor="message">Your message</label><textarea id="message" value={draft} onChange={event => setDraft(event.target.value)} placeholder="Ask a question…" maxLength={8000} disabled={!conversation || busy} rows={3} /><button type="submit" disabled={!conversation || busy || !draft.trim()}>Send <span aria-hidden="true">↑</span></button></form><label className="verify"><input type="checkbox" checked={verifyCurrent} disabled={busy} onChange={event => setVerifyCurrent(event.target.checked)} /> Verify current information with fresh search</label><p>Responses can be inaccurate. Check important information.</p></div></main></div>;
}

createRoot(document.getElementById('root')!).render(<App />);

import React, { useEffect, useRef, useState } from 'react';
import { SourceCode } from '../SourceCode';
import { Markdown } from '../Markdown';

interface Settings { preset: string; autoVerify: boolean; maxCost: number; inputPrice: number; outputPrice: number }
interface State {
  settings: Settings; memory: string; canResume: boolean; interrupted: boolean; startedAt: number | null; finishedAt: number | null;
  plan: { text: string; status: string; blocker?: string }[];
  proposals: { id: string; path: string; patch?: string; before: string | null; content: string; status: string }[];
  approvals: { id: string; tool: string; args: unknown; status: string }[];
  checkpoints: { id: string; label: string; files: number; createdAt: number }[];
  specialists: { id: string; role: string; task: string; status: string; report: string }[];
  usage: { input: number; output: number; estimatedCost: number };
  verification: null | { status: string; error?: string; results: { label: string; exitCode: number; output: string }[] };
  browser: null | { title: string; status: number; path: string; errors: string[]; console: { type: string; text: string }[]; blocked: string[]; dataUrl?: string };
}
async function request(id: string, action?: unknown, signal?: AbortSignal): Promise<State & { resumed?: string }> {
  const res = await fetch(`/api/v1/ai/jobs/${encodeURIComponent(id)}/controls`, {
    method: action ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('nixre_token') || ''}` },
    signal,
    ...(action ? { body: JSON.stringify(action) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.message || 'Could not load task controls');
  return body;
}
const btn = 'rounded border border-border-subtle px-2 py-1 text-xs hover:bg-surface-subtle disabled:opacity-40';
const field = 'rounded border border-border-subtle bg-surface-base px-2 py-1 text-xs text-txt-primary';
export function AgentTaskPanel({ conversationId, running, onResume }: { conversationId: string; running: boolean; onResume: () => void }) {
  const [state, setState] = useState<State | null>(null), [settings, setSettings] = useState<Settings | null>(null);
  const [memory, setMemory] = useState(''), [url, setUrl] = useState('http://localhost:3000');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [now, setNow] = useState(Date.now());
  const dirty = useRef(false), generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    dirty.current = false; setState(null); setError('');
    let inflight: AbortController | null = null;
    const refresh = async (force = false) => {
      if (inflight && !force) return;
      inflight?.abort();
      const controller = new AbortController();
      inflight = controller;
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const next = await request(conversationId, undefined, controller.signal);
        if (current !== generation.current || controller.signal.aborted) return;
        setState(next); setNow(Date.now());
        setError('');
        if (!dirty.current) { setSettings(next.settings); setMemory(next.memory || ''); }
      } catch (err) { if (current === generation.current && !controller.signal.aborted) setError((err as Error).message); }
      finally { clearTimeout(timeout); if (inflight === controller) inflight = null; }
    };
    const wake = () => { if (document.visibilityState !== 'hidden') void refresh(true); };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('focus', wake);
    window.addEventListener('online', wake);
    void refresh(); const timer = setInterval(refresh, 2500);
    return () => {
      clearInterval(timer); inflight?.abort(); generation.current++;
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('focus', wake);
      window.removeEventListener('online', wake);
    };
  }, [conversationId]);
  const act = async (action: unknown) => {
    const current = generation.current;
    setBusy(true); setError('');
    try { const next = await request(conversationId, action); if (current === generation.current) { setState(next); if (next.resumed) onResume(); } }
    catch (err) { if (current === generation.current) setError((err as Error).message); }
    finally { if (current === generation.current) setBusy(false); }
  };
  const blocked = busy || running;
  const elapsed = state?.startedAt ? Math.max(0, Math.floor(((state.finishedAt || now) - state.startedAt) / 1000)) : 0;
  const pending = state?.proposals.filter(p => p.status === 'pending') || [];
  return <section aria-label="Agent task controls" className="rounded-xl border border-border-subtle bg-surface-base/50 p-3 text-xs space-y-3">
    <div className="flex flex-wrap justify-between gap-2 font-medium"><span>Task controls {pending.length > 0 && `· ${pending.length} files to review`}</span>
      {state && <span className="text-txt-tertiary">{(state.usage.input + state.usage.output).toLocaleString()} tokens · {elapsed}s · {state.settings.inputPrice > 0 && state.settings.outputPrice > 0 ? `~$${state.usage.estimatedCost.toFixed(4)}` : 'Cost not configured'}</span>}</div>
    {error && <p role="alert" className="text-feedback-error-text">{error}</p>}
    {state?.approvals.some(a => a.status === 'pending') && <p role="status" className="font-semibold text-brand">Waiting for your approval — the requested command or check has not started. Approve or deny below to continue.</p>}
    {state?.plan.length ? <ol className="space-y-1" aria-label="Task checklist">{state.plan.map((p, i) => <li key={i} className="flex flex-wrap gap-2"><span>{p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '→' : '○'}</span><span>{p.text}</span><span className="text-txt-tertiary">{p.status.replace('_', ' ')}</span>{p.blocker && <span>{p.blocker}</span>}</li>)}</ol> : <p className="text-txt-tertiary">The agent’s checklist will appear here.</p>}
    {state?.approvals.filter(a => a.status === 'pending').map(a => <div key={a.id} className="rounded border border-brand p-3 space-y-2"><strong>Approval requested: {a.tool}</strong><pre className="overflow-x-auto whitespace-pre-wrap break-all">{JSON.stringify(a.args, null, 2)}</pre><button type="button" className={btn} disabled={busy} onClick={() => act({ type: 'approval', id: a.id, accept: true })}>Approve once</button>{' '}<button type="button" className={btn} disabled={busy} onClick={() => act({ type: 'approval', id: a.id, accept: false })}>Deny</button></div>)}
    {state && <details><summary className="cursor-pointer font-medium">Changes, checkpoints, and checks</summary><div className="space-y-3 mt-3">
      {pending.map(p => <details key={p.id} className="border border-border-subtle rounded p-2"><summary className="cursor-pointer">{p.path} · {p.before === null ? 'new file' : 'modified'}</summary><pre className="my-2 max-h-72 overflow-auto" aria-label={`Diff for ${p.path}`}>{p.patch?.split("\n").map((line, i) => <span key={i} className={`block ${line.startsWith("+") ? "text-txt-open" : line.startsWith("-") ? "text-feedback-error-text" : "text-txt-tertiary"}`}>{line || " "}</span>)}</pre><div className="grid md:grid-cols-2 gap-2 min-w-0 mt-2"><div className="min-w-0"><p>Before</p><SourceCode filename={p.path} content={p.before ?? '(new file)'} /></div><div className="min-w-0"><p>Proposed</p><SourceCode filename={p.path} content={p.content} /></div></div><button type="button" className={btn} disabled={blocked || state.settings.preset === 'read_only'} onClick={() => act({ type: 'proposal', id: p.id, accept: true })}>{state.settings.autoVerify ? 'Accept file and run checks' : 'Accept file'}</button>{' '}<button type="button" className={btn} disabled={blocked} onClick={() => act({ type: 'proposal', id: p.id, accept: false })}>Reject file</button></details>)}
      {!pending.length && <p className="text-txt-tertiary">No pending file proposals.</p>}
      {running && <p className="text-txt-tertiary">File review is available when the task stops.</p>}
      <div className="flex flex-wrap gap-2"><button type="button" className={btn} disabled={blocked} onClick={() => act({ type: 'checkpoint' })}>Save checkpoint</button><button type="button" className={btn} disabled={blocked || state.settings.preset === 'read_only'} onClick={() => act({ type: 'verify' })}>Run tests, lint, and build</button>{state.canResume && <button type="button" className={btn} disabled={blocked} onClick={() => act({ type: 'resume' })}>Resume saved task</button>}</div>
      {state.interrupted && <p>Interrupted task: resume uses saved progress without automatically repeating actions with unknown outcomes.</p>}
      <p className="text-txt-tertiary">Checkpoints restore workspace files and uncommitted changes. Git commits and the index stay intact. Ignored files are excluded.</p>
      {state.checkpoints.slice().reverse().map(c => <div key={c.id} className="flex flex-wrap justify-between gap-2"><span>{c.label} · {c.files} files · {new Date(c.createdAt).toLocaleString()}</span><button type="button" className={btn} disabled={blocked || state.settings.preset === 'read_only'} onClick={() => act({ type: 'restore', id: c.id })}>Restore files</button></div>)}
      {state.verification && <div><strong>Verification: {state.verification.status.replace('_', ' ')}</strong>{state.verification.error && <p>{state.verification.error}</p>}{state.verification.results.map((r, i) => <details key={i}><summary>{r.exitCode === 0 ? '✓' : '✗'} {r.label} · exit {r.exitCode}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap">{r.output}</pre></details>)}</div>}
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); void act({ type: 'browser', url }); }}><input className={`${field} flex-1`} aria-label="Local preview URL" value={url} onChange={e => setUrl(e.target.value)} /><button className={btn} disabled={blocked || state.settings.preset === 'read_only'}>Inspect preview</button></form>
      {state.browser && <div className="space-y-1"><strong>{state.browser.title} · HTTP {state.browser.status}</strong><p>Screenshot: {state.browser.path}</p>{state.browser.dataUrl && <img src={state.browser.dataUrl} alt="Browser check screenshot" className="max-w-full rounded" />}<p>{state.browser.errors.length} page errors · {state.browser.blocked.length} external resources blocked</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{[...state.browser.errors, ...state.browser.console.map(c => `${c.type}: ${c.text}`)].join('\n')}</pre></div>}
    </div></details>}
    {!!state?.specialists.length && <details><summary className="cursor-pointer font-medium">Specialist findings ({state.specialists.length})</summary>{state.specialists.map(c => <div key={c.id} className="mt-2 border-l-2 border-brand pl-3"><strong>{c.role} · {c.status}</strong><p>{c.task}</p><Markdown content={c.report} /></div>)}</details>}
    {settings && <details><summary className="cursor-pointer font-medium">Permissions, spending, and project memory</summary><div className="mt-3 space-y-3">
      <label className="flex flex-wrap gap-2 items-center">Permission preset<select className={field} disabled={blocked} value={settings.preset} onChange={e => { dirty.current = true; setSettings({ ...settings, preset: e.target.value }); }}><option value="read_only">Read only</option><option value="workspace">Review edits and approve commands</option><option value="restricted">Review edits and approved checks only</option></select></label>
      <label className="flex gap-2"><input type="checkbox" disabled={blocked} checked={settings.autoVerify} onChange={e => { dirty.current = true; setSettings({ ...settings, autoVerify: e.target.checked }); }} />Run repository checks when accepting edits</label>
      <div className="grid sm:grid-cols-2 gap-2">{([['maxCost', 'Spending limit USD (0 = off)'], ['inputPrice', 'Input price USD / million tokens'], ['outputPrice', 'Output price USD / million tokens']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-1">{label}<input type="number" min="0" step="any" className={field} disabled={blocked} value={settings[key]} onChange={e => { dirty.current = true; setSettings({ ...settings, [key]: Number(e.target.value) }); }} /></label>)}</div>
      <p className="text-txt-tertiary">Token usage and elapsed time are tracked without task-level caps. Enter provider prices for the selected model. The optional spending limit is checked between calls; an in-flight response can exceed it. Update prices when changing models.</p><button type="button" className={btn} disabled={blocked} onClick={() => act({ type: 'settings', settings })}>Save task settings</button>
      <label className="block">Project memory<textarea aria-label="Project memory" rows={6} maxLength={12000} className={`${field} w-full mt-1`} value={memory} disabled={blocked} onChange={e => { dirty.current = true; setMemory(e.target.value); }} /></label><p className="text-txt-tertiary">Architecture, conventions, and decisions shared across your conversations in this repository.</p><button type="button" className={btn} disabled={blocked} onClick={() => act({ type: 'memory', content: memory })}>Save project memory</button>
    </div></details>}
  </section>;
}

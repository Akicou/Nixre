import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { api, SecurityScanState, SecurityScanSettings as Settings, SecurityScanRun } from '../lib/api';
import { Markdown } from './Markdown';

const STATUS_CLS: Record<SecurityScanRun['status'], string> = {
  running: 'bg-surface-open text-txt-open',
  ok: 'bg-surface-merged text-txt-merged',
  error: 'bg-surface-closed text-txt-closed',
  skipped: 'bg-surface-subtle text-txt-secondary',
};

export const SecurityScanSettings: React.FC = () => {
  const [state, setState] = useState<SecurityScanState | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [reports, setReports] = useState<Record<number, SecurityScanRun>>({});
  const loaded = useRef(false);

  const apply = (s: SecurityScanState) => {
    setState(s);
    if (!loaded.current) { setForm(s.settings); loaded.current = true; }
  };

  useEffect(() => {
    let live = true;
    api.getSecurityScan().then(
      s => { if (live) apply(s); },
      e => { if (live) setMsg(e instanceof Error ? e.message : 'Could not load'); },
    );
    return () => { live = false; };
  }, []);

  const running = state?.running ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { api.getSecurityScan().then(apply, () => {}); }, 5000);
    return () => clearInterval(t);
  }, [running]);

  if (!state || !form) {
    return <div className="text-xs text-txt-tertiary font-mono">{msg || 'Loading security scan…'}</div>;
  }

  const provider = state.providers.find(p => p.id === form.providerId);
  const models = provider ? [...new Set([provider.defaultModel, ...provider.models].filter(Boolean))] : [];

  const save = async () => {
    setBusy(true); setMsg('');
    try {
      const s = await api.saveSecurityScan(form);
      setState(s); setForm(s.settings); setMsg('Saved.');
    } catch (e) { setMsg(e instanceof Error ? e.message : 'Save failed'); }
    setBusy(false);
  };
  const runNow = async () => {
    setBusy(true); setMsg('');
    try { await api.runSecurityScan(); apply(await api.getSecurityScan()); }
    catch (e) { setMsg(e instanceof Error ? e.message : 'Could not start'); }
    setBusy(false);
  };
  const toggleRun = async (r: SecurityScanRun) => {
    if (open === r.id) { setOpen(null); return; }
    setOpen(r.id);
    if (!reports[r.id]) {
      try {
        const full = await api.getSecurityScanRun(r.id);
        setReports(p => ({ ...p, [r.id]: full }));
      } catch { /* report stays empty */ }
    }
  };

  const field = 'bg-surface-base border border-border-subtle rounded px-2 py-1.5 text-sm';

  return (
    <div className="border-t border-border-subtle pt-6 space-y-4">
      <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-brand" />
        <span>Security scan</span>
      </h2>
      <p className="text-xs text-txt-secondary">
        Periodically checks running deployments for known CVEs with the assistant, and files issues with fixes.
      </p>

      <div className="grid sm:grid-cols-2 gap-4 max-w-3xl">
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} />
          Enable scheduled scans
        </label>
        <label className="text-xs space-y-1 flex flex-col">
          Interval (hours)
          <input
            type="number" min={1} max={168} className={field} value={form.intervalHours}
            onChange={e => setForm({ ...form, intervalHours: Math.min(168, Math.max(1, Number(e.target.value) || 1)) })}
          />
        </label>
        <label className="text-xs space-y-1 flex flex-col">
          Core repo for instance findings (space/repo, optional)
          <input className={field} value={form.coreRepo} onChange={e => setForm({ ...form, coreRepo: e.target.value })} />
        </label>
        <label className="text-xs space-y-1 flex flex-col">
          Provider
          <select
            className={field} value={form.providerId ?? ''}
            onChange={e => {
              const id = e.target.value ? Number(e.target.value) : null;
              const p = state.providers.find(x => x.id === id);
              setForm({ ...form, providerId: id, model: p?.defaultModel ?? '' });
            }}
          >
            <option value="">Select a provider…</option>
            {state.providers.map(p => <option key={p.id} value={p.id}>{p.label} ({p.provider})</option>)}
          </select>
        </label>
        <label className="text-xs space-y-1 flex flex-col">
          Model
          <select className={field} value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} disabled={!provider}>
            <option value="">Select a model…</option>
            {models.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
      </div>

      <div className="flex items-center gap-3">
        <button onClick={save} disabled={busy} className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50">
          Save
        </button>
        <button onClick={runNow} disabled={busy || running} className="px-3 py-1.5 rounded text-xs font-medium border border-border-subtle hover:bg-surface-subtle disabled:opacity-50">
          {running ? 'Scan running…' : 'Run now'}
        </button>
        {msg && <span className="text-xs text-txt-secondary" role="status">{msg}</span>}
      </div>

      <div className="border-y border-border-subtle divide-y divide-border-subtle">
        {state.runs.length === 0 ? (
          <div className="p-6 text-center text-xs text-txt-tertiary">No scans yet.</div>
        ) : state.runs.map(r => (
          <div key={r.id}>
            <button onClick={() => toggleRun(r)} className="w-full text-left py-2.5 flex items-center justify-between gap-3 hover:bg-surface-subtle/50">
              <div className="min-w-0">
                <p className="text-xs text-txt-primary truncate">{r.summary || r.error || 'No summary'}</p>
                <p className="text-[11px] text-txt-tertiary font-mono">
                  {new Date(r.started).toLocaleString()} · {r.trigger} · {r.findings} findings · {r.issues_created} issues
                </p>
              </div>
              <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold shrink-0 ${STATUS_CLS[r.status]}`}>{r.status}</span>
            </button>
            {open === r.id && (
              <div className="pb-3">
                {r.error && <p className="text-xs text-red-400 mb-2">{r.error}</p>}
                {reports[r.id]?.report
                  ? <Markdown content={reports[r.id].report!.markdown} />
                  : <p className="text-xs text-txt-tertiary">{reports[r.id] ? 'No report.' : 'Loading report…'}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

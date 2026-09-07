import { useCallback, useEffect, useState } from 'react';
import { Check, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { observeUpdate, rememberUpdate, type UpdateJob, type UpdateState } from '../lib/instanceUpdates';

const guide = 'https://github.com/Akicou/Nixre/blob/main/docs/instance-updates.md';
const button = 'rounded border border-border-subtle px-3 py-2 text-xs font-semibold disabled:opacity-40 hover:bg-surface-subtle';
const active = (job?: UpdateJob) => job && ['checking', 'running'].includes(job.status);

export function UpdateProgressDetails({ job }: { job: UpdateJob }) {
  const failed = ['failed', 'recovery_required'].includes(job.status);
  return <div className="space-y-3" aria-live="polite">
    <div className="flex items-center gap-2 text-sm font-semibold">
      {active(job) ? <Loader2 className="w-4 h-4 animate-spin" /> : failed ? <TriangleAlert className="w-4 h-4 text-feedback-error-text" /> : <Check className="w-4 h-4 text-txt-open" />}
      <span>{job.status === 'recovery_required' ? 'Operator recovery required' : job.status.replace(/_/g, ' ')}</span>
    </div>
    {job.message && <p className={`text-sm ${failed ? 'text-feedback-error-text' : 'text-txt-secondary'}`}>{job.message}</p>}
    <ol className="space-y-2">
      {job.steps.map(step => <li key={step.name} className="border-l-2 border-border-subtle pl-3 text-xs">
        <span className={step.status === 'failed' ? 'text-feedback-error-text' : 'text-txt-primary'}>{step.name} — {step.status}</span>
        {step.message && <p className="text-feedback-error-text mt-1">{step.message}</p>}
      </li>)}
    </ol>
    {job.database && <p className="text-xs">Database: <strong>{job.database}</strong></p>}
    {job.backup && <p className="text-xs break-all">Verified backup on host: <code>{job.backup}</code></p>}
    {job.migrations && <details className="text-xs"><summary>Verified migrations ({job.migrations.length})</summary><ul className="mt-2 font-mono">{job.migrations.map(version => <li key={version}>{version}</li>)}</ul></details>}
    {job.cleanupWarning && <p className="text-xs text-feedback-error-text">{job.cleanupWarning}</p>}
    {failed && <p className="text-xs break-all">Private diagnostic log: <code>data/updater/{job.id}.log</code>. <a className="underline" href={guide}>Recovery guide</a></p>}
  </div>;
}

export function InstanceUpdates() {
  const [state, setState] = useState<UpdateState>();
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const refresh = useCallback(async () => {
    try {
      const result = await api.getInstanceUpdates();
      setState(result); rememberUpdate(result.watchToken); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not connect to the updater.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!active(state?.current)) return;
    const timer = setInterval(() => { void refresh(); }, 2500);
    return () => clearInterval(timer);
  }, [state?.current?.status, refresh]);
  useEffect(() => { setReviewed(false); }, [state?.current?.plan?.id]);
  const perform = async (apply: boolean) => {
    setPending(true); setError('');
    try {
      const plan = state?.current?.plan;
      const result = apply && plan
        ? await api.applyInstanceUpdate({ requestId: crypto.randomUUID(), planId: plan.id, target: plan.target, expectedBase: plan.base })
        : await api.checkInstanceUpdate(crypto.randomUUID());
      rememberUpdate(result.watchToken);
      setState(previous => ({ ...previous, ...result, enabled: true }));
      if (apply) window.location.assign('/update-progress');
    } catch (e) { setError(e instanceof Error ? e.message : 'Request interrupted. Reconnect to check whether it was accepted.'); }
    finally { setPending(false); }
  };
  const plan = state?.current?.status === 'checked' ? state.current.plan : undefined;
  const locked = pending || active(state?.current) || state?.current?.status === 'recovery_required';
  return <section className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">Instance updates</h2>
      <button className={button} disabled={pending} onClick={() => { void refresh(); }}><RefreshCw className="inline w-3 h-3 mr-1" />Reconnect</button>
    </div>
    <p className="text-xs text-txt-secondary">Review a CI-verified revision, then let the updater build, back up, rehearse migrations, and verify the deployment. Progress remains available during backend restarts.</p>
    <a href={guide} className="inline-block underline text-xs text-brand">Setup and recovery instructions</a>
    {error && <p role="alert" className="text-xs text-feedback-error-text">{error}</p>}
    {!state && !error && <p className="text-xs">Connecting to updater…</p>}
    {state?.enabled === false && <p className="text-sm">One-time host setup required. <a href={guide} className="underline text-brand">Install the updater</a> to enable this button.</p>}
    {state?.enabled && <button className={button} disabled={!!locked || !!error} onClick={() => { void perform(false); }}>Check for updates</button>}
    {state?.current && <UpdateProgressDetails job={state.current} />}
    {state?.watchToken && <a href="/update-progress" className="inline-block underline text-xs text-brand">Open independent progress page</a>}
    {plan && <div className="rounded border border-border-subtle p-4 space-y-3">
      <p className="text-sm font-semibold">{plan.available ? 'Update ready for review' : 'Already up to date'}</p>
      <p className="font-mono text-xs">{plan.base.slice(0, 8)} → {plan.target.slice(0, 8)}</p>
      <a className="underline text-xs text-brand" href={plan.ciUrl} target="_blank" rel="noreferrer">View passing CI</a>
      <details className="text-xs"><summary>Changed files ({plan.totalFiles})</summary><ul className="mt-2 font-mono space-y-1">{plan.files.map(file => <li key={file.path} className="break-all">{file.status} {file.path}</li>)}</ul>{plan.totalFiles > plan.files.length && <p>Showing the first {plan.files.length} files. Review the complete revision on GitHub.</p>}</details>
      <p className="text-xs font-semibold">{plan.migrations.length ? `${plan.migrations.length} new database migrations` : 'No new database migrations'}</p>
      {!!plan.migrations.length && <ul className="text-xs font-mono">{plan.migrations.map(version => <li key={version} className="break-all">{version}</li>)}</ul>}
      {plan.available && <>
        <p className="text-xs text-txt-secondary">Core and SSH pause during the final backup, migrations, and activation. A committed or uncertain migration will require operator recovery if startup fails; the updater will not automatically restore the database.</p>
        <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} />I reviewed the changes and can allow this maintenance window.</label>
        <button className={`${button} bg-brand text-white`} disabled={!reviewed || !!locked || !!error} onClick={() => { void perform(true); }}>Back up and update</button>
      </>}
    </div>}
    {!!state?.history?.length && <details className="text-xs"><summary>Recent update history</summary><ul className="space-y-2 mt-2">{state.history.map(job => <li key={job.id}>{new Date(job.startedAt).toLocaleString()} · {job.actor} · {job.status}{job.message ? ` — ${job.message}` : ''}</li>)}</ul></details>}
  </section>;
}

// Mounted before the normal session bootstrap so a stopped core cannot leave
// the observer stuck at "Initializing Nixre" or redirect it to login.
export function UpdateProgressPage() {
  const [job, setJob] = useState<UpdateJob>();
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let finished = false;
      try {
        const result = await observeUpdate();
        if (!disposed) { setJob(result); setError(''); }
        finished = !active(result);
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : 'Progress connection interrupted. Retrying…'); }
      if (!disposed && !finished) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  return <main className="min-h-screen bg-surface-base text-txt-primary px-4 py-10">
    <div className="max-w-2xl mx-auto space-y-5">
      <h1 className="text-xl font-semibold">Nixre update progress</h1>
      <p className="text-sm text-txt-secondary">This read-only connection works independently of the backend. You can refresh this page in the same browser tab during maintenance.</p>
      {error && <p role="alert" className="text-sm text-feedback-error-text">{error}</p>}
      {job ? <UpdateProgressDetails job={job} /> : !error && <p>Connecting…</p>}
      <div className="flex gap-4 text-sm"><a href="/admin" className="underline">Return to Admin</a><a href={guide} className="underline">Setup & recovery guide</a></div>
    </div>
  </main>;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Ban,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Loader2,
  MinusCircle,
  Play,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api, WorkflowInfo, WorkflowJob, WorkflowRun } from '../lib/api';
import { subscribeRunEvents } from '../lib/actionEvents';

// --- shared bits ------------------------------------------------------------------

type Status = { status: string; conclusion: string | null | undefined };

export function RunStatusIcon({ status, conclusion, className = 'w-4 h-4' }: Status & { className?: string }) {
  if (status !== 'completed') {
    return status === 'running' ? (
      <Loader2 aria-label="In progress" className={`${className} animate-spin text-feedback-warning-text`} />
    ) : (
      <Clock aria-label="Queued" className={`${className} text-txt-tertiary`} />
    );
  }
  if (conclusion === 'success') return <CheckCircle2 aria-label="Succeeded" className={`${className} text-feedback-success-text`} />;
  if (conclusion === 'failure') return <XCircle aria-label="Failed" className={`${className} text-feedback-error-text`} />;
  if (conclusion === 'cancelled') return <Ban aria-label="Cancelled" className={`${className} text-txt-tertiary`} />;
  return <MinusCircle aria-label="Skipped" className={`${className} text-txt-tertiary`} />;
}

function duration(start: number | null | undefined, end: number | null | undefined): string {
  if (!start) return '';
  const s = Math.max(0, Math.round(((end || Date.now()) - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function trigger(run: WorkflowRun): string {
  if (run.event === 'pull_request') return `PR #${run.pr_number}`;
  if (run.event === 'schedule') return 'scheduled';
  if (run.event === 'workflow_dispatch') return `manual on ${run.branch || run.tag || run.sha.slice(0, 7)}`;
  return run.tag ? `tag ${run.tag}` : `push to ${run.branch}`;
}

// Strip ANSI colour codes; logs are shown as plain monospace text.
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** Split a stored job log into sections keyed by step index (-1 = set up). */
export function splitLog(log: string): Map<number, string[]> {
  const sections = new Map<number, string[]>();
  let current = -1;
  for (const line of log.split('\n')) {
    const marker = /^##\[step:(-?\d+)\]$/.exec(line);
    if (marker) {
      current = Number(marker[1]);
      if (!sections.has(current)) sections.set(current, []);
      continue;
    }
    if (line === '') continue;
    if (!sections.has(current)) sections.set(current, []);
    sections.get(current)!.push(line);
  }
  return sections;
}

const SAMPLE = `# .nixre/workflows/ci.yml
name: CI
on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest   # node:22-bookworm
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm test`;

// --- panel ----------------------------------------------------------------------------

export const ActionsPanel: React.FC<{
  repoPath: string;
  defaultBranch: string;
  canWrite: boolean;
  signedIn: boolean;
  selectedRun: number | null;
  onSelectRun: (n: number | null) => void;
}> = ({ repoPath, defaultBranch, canWrite, signedIn, selectedRun, onSelectRun }) => {
  if (selectedRun) {
    return <RunDetail repoPath={repoPath} number={selectedRun} onBack={() => onSelectRun(null)} onOpenRun={onSelectRun} />;
  }
  return (
    <RunList repoPath={repoPath} defaultBranch={defaultBranch} canWrite={canWrite} signedIn={signedIn} onSelectRun={onSelectRun} />
  );
};

// --- run list -----------------------------------------------------------------------------

const RunList: React.FC<{
  repoPath: string;
  defaultBranch: string;
  canWrite: boolean;
  signedIn: boolean;
  onSelectRun: (n: number) => void;
}> = ({ repoPath, defaultBranch, canWrite, onSelectRun }) => {
  const [workflows, setWorkflows] = useState<WorkflowInfo[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [error, setError] = useState('');
  const [dispatchOpen, setDispatchOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    api.listWorkflows(repoPath).then(r => alive && setWorkflows(r.workflows)).catch(() => alive && setWorkflows([]));
    return () => {
      alive = false;
    };
  }, [repoPath]);

  const load = useCallback(() => {
    return api
      .listRuns(repoPath, { workflow: filter || undefined })
      .then(r => {
        setRuns(r.runs);
        setError('');
      })
      .catch(e => setError(e.message || 'Failed to load runs'));
  }, [repoPath, filter]);

  useEffect(() => {
    setRuns(null);
    void load();
  }, [load]);

  // Poll while anything is queued or running.
  const busy = !!runs?.some(r => r.status !== 'completed');
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [busy, load]);

  const selected = workflows?.find(w => w.path === filter) || null;
  const badgeUrl = selected
    ? `${window.location.origin}/api/v1/repos/${repoPath}/+/actions/badge.svg?workflow=${encodeURIComponent(selected.path.split('/').pop() || '')}`
    : '';

  return (
    <div className="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] gap-6 min-w-0">
      <nav aria-label="Workflows" className="space-y-1 min-w-0">
        <h3 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Workflows</h3>
        <button
          type="button"
          onClick={() => setFilter('')}
          className={`w-full text-left px-2 py-1.5 rounded text-sm ${filter === '' ? 'bg-surface-subtle text-txt-primary font-medium' : 'text-txt-secondary hover:text-txt-primary'}`}
        >
          All workflows
        </button>
        {workflows?.map(w => (
          <button
            key={w.path}
            type="button"
            onClick={() => setFilter(w.path)}
            title={w.error || w.path}
            className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-1.5 min-w-0 ${filter === w.path ? 'bg-surface-subtle text-txt-primary font-medium' : 'text-txt-secondary hover:text-txt-primary'}`}
          >
            {w.error && <TriangleAlert className="w-3.5 h-3.5 shrink-0 text-feedback-error-text" />}
            <span className="truncate">{w.name}</span>
          </button>
        ))}
      </nav>

      <div className="space-y-4 min-w-0">
        {selected && (
          <div className="space-y-3 border-b border-border-subtle pb-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-txt-primary">{selected.name}</h3>
                <p className="text-xs font-mono text-txt-tertiary truncate">{selected.path}</p>
              </div>
              {canWrite && selected.inputs && (
                <button
                  type="button"
                  onClick={() => setDispatchOpen(o => !o)}
                  className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover inline-flex items-center gap-1.5"
                >
                  <Play className="w-3.5 h-3.5" />
                  Run workflow
                </button>
              )}
            </div>
            {selected.error && (
              <p role="alert" className="text-xs text-feedback-error-text">
                {selected.error}
              </p>
            )}
            {selected.schedule.length > 0 && (
              <p className="text-xs text-txt-secondary">
                Scheduled: <span className="font-mono">{selected.schedule.join(', ')}</span> (UTC)
              </p>
            )}
            {dispatchOpen && selected.inputs && (
              <DispatchForm
                repoPath={repoPath}
                workflow={selected}
                defaultBranch={defaultBranch}
                onDone={run => {
                  setDispatchOpen(false);
                  onSelectRun(run.number);
                }}
              />
            )}
            <BadgeSnippet url={badgeUrl} name={selected.name} />
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-feedback-error-text">
            {error}
          </p>
        )}
        {runs === null ? (
          <p className="py-10 text-center text-sm text-txt-tertiary">Loading runs...</p>
        ) : runs.length === 0 ? (
          <div className="py-8 space-y-3">
            <p className="text-sm text-txt-primary font-medium">No workflow runs yet</p>
            <p className="text-sm text-txt-secondary">
              Add a workflow in <code className="font-mono text-xs">.nixre/workflows/</code> (
              <code className="font-mono text-xs">.gitea/workflows</code> and <code className="font-mono text-xs">.github/workflows</code> work too)
              and push. Jobs run in containers with the repository checked out; secrets come from repository settings.
            </p>
            <pre className="text-xs font-mono bg-surface-subtle border border-border-subtle rounded p-3 overflow-x-auto text-txt-secondary">
              {SAMPLE}
            </pre>
          </div>
        ) : (
          <ul className="divide-y divide-border-subtle border-y border-border-subtle">
            {runs.map(run => (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => onSelectRun(run.number)}
                  className="w-full text-left py-3 px-1 flex items-start gap-3 hover:bg-surface-subtle/50 min-w-0"
                >
                  <RunStatusIcon status={run.status} conclusion={run.conclusion} className="w-4 h-4 mt-0.5 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-txt-primary font-medium truncate">
                      {run.workflow_name} <span className="text-txt-tertiary font-normal">#{run.number}</span>
                    </span>
                    <span className="block text-xs text-txt-tertiary truncate">
                      {trigger(run)} · <span className="font-mono">{run.sha.slice(0, 7)}</span>
                      {run.actor ? ` · ${run.actor}` : ''}
                      {run.error ? ` · ${run.error}` : ''}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-xs text-txt-tertiary">
                    <span className="block">{ago(run.created)}</span>
                    {run.started && <span className="block font-mono">{duration(run.started, run.finished)}</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

const BadgeSnippet: React.FC<{ url: string; name: string }> = ({ url, name }) => {
  const [copied, setCopied] = useState(false);
  const md = `![${name}](${url})`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <img src={url} alt={`${name} status badge`} className="h-5" />
      <code className="font-mono text-txt-tertiary truncate max-w-full min-w-0 flex-1">{md}</code>
      <button
        type="button"
        title="Copy badge Markdown"
        onClick={() => void navigator.clipboard?.writeText(md).then(() => setCopied(true))}
        className="text-txt-secondary hover:text-brand inline-flex items-center gap-1"
      >
        {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? 'Copied' : 'Copy badge'}
      </button>
    </div>
  );
};

const DispatchForm: React.FC<{
  repoPath: string;
  workflow: WorkflowInfo;
  defaultBranch: string;
  onDone: (run: WorkflowRun) => void;
}> = ({ repoPath, workflow, defaultBranch, onDone }) => {
  const [ref, setRef] = useState(defaultBranch);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.entries(workflow.inputs || {}).map(([k, d]) => [k, d.default])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = 'w-full px-2 py-1.5 rounded bg-surface-canvas border border-border-subtle text-sm text-txt-primary';
  return (
    <form
      className="space-y-3 border-l-2 border-brand pl-3"
      onSubmit={e => {
        e.preventDefault();
        setBusy(true);
        setError('');
        api
          .dispatchWorkflow(repoPath, workflow.path, ref, values)
          .then(onDone)
          .catch(err => setError(err.message || 'Could not start the workflow'))
          .finally(() => setBusy(false));
      }}
    >
      <label className="block text-xs text-txt-secondary">
        Branch or tag
        <input aria-label="Branch or tag" className={field} value={ref} onChange={e => setRef(e.target.value)} />
      </label>
      {Object.entries(workflow.inputs || {}).map(([name, def]) => (
        <label key={name} className="block text-xs text-txt-secondary">
          {def.description || name}
          {def.required && <span className="text-feedback-error-text"> *</span>}
          {def.type === 'boolean' ? (
            <input
              type="checkbox"
              aria-label={name}
              className="ml-2 align-middle"
              checked={values[name] === 'true'}
              onChange={e => setValues(v => ({ ...v, [name]: String(e.target.checked) }))}
            />
          ) : def.type === 'choice' ? (
            <select aria-label={name} className={field} value={values[name]} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}>
              {def.options.map(o => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label={name} className={field} value={values[name] ?? ''} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} />
          )}
        </label>
      ))}
      {error && (
        <p role="alert" className="text-xs text-feedback-error-text">
          {error}
        </p>
      )}
      <button type="submit" disabled={busy} className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50">
        {busy ? 'Starting...' : 'Run'}
      </button>
    </form>
  );
};

// --- run detail ---------------------------------------------------------------------------

const RunDetail: React.FC<{
  repoPath: string;
  number: number;
  onBack: () => void;
  onOpenRun: (n: number) => void;
}> = ({ repoPath, number, onBack, onOpenRun }) => {
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [acting, setActing] = useState(false);

  const load = useCallback(
    () =>
      api
        .getRun(repoPath, number)
        .then(r => {
          setRun(r.run);
          setJobs(r.jobs);
          setCanWrite(r.can_write);
          setJobId(id => id ?? r.jobs.find(j => j.status === 'running')?.id ?? r.jobs.find(j => j.conclusion === 'failure')?.id ?? r.jobs[0]?.id ?? null);
        })
        .catch(e => setError(e.message || 'Failed to load run')),
    [repoPath, number],
  );

  useEffect(() => {
    setRun(null);
    setJobs([]);
    setJobId(null);
    void load();
  }, [load]);

  const active = run ? run.status !== 'completed' : false;
  useEffect(() => {
    if (!active) return;
    // Live job/step status; log text is polled from the stored log (JobLog).
    const off = subscribeRunEvents(repoPath, number, evt => {
      if (evt.type === 'job' && evt.jobId) {
        setJobs(prev =>
          prev.map(j =>
            j.id === evt.jobId ? { ...j, status: (evt.status as WorkflowJob['status']) || j.status, conclusion: (evt.conclusion as WorkflowJob['conclusion']) ?? j.conclusion, steps: (evt.steps as WorkflowJob['steps']) || j.steps } : j,
          ),
        );
      } else if (evt.type === 'end' || (evt.type === 'run' && evt.status === 'completed')) {
        void load();
      }
    });
    return off;
  }, [active, repoPath, number, load]);

  const job = jobs.find(j => j.id === jobId) || null;

  const act = (fn: () => Promise<unknown>) => {
    setActing(true);
    setError('');
    fn()
      .catch(e => setError(e.message || 'Action failed'))
      .finally(() => setActing(false));
  };

  if (!run) {
    return <p className="py-10 text-center text-sm text-txt-tertiary">{error || 'Loading run...'}</p>;
  }

  return (
    <div className="space-y-5 min-w-0">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-txt-brand hover:underline">
        <ArrowLeft className="w-3.5 h-3.5" /> All runs
      </button>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border-subtle pb-4">
        <div className="min-w-0 space-y-1">
          <h3 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
            <RunStatusIcon status={run.status} conclusion={run.conclusion} className="w-5 h-5" />
            <span className="truncate">
              {run.workflow_name} <span className="text-txt-tertiary font-normal">#{run.number}</span>
            </span>
          </h3>
          <p className="text-xs text-txt-tertiary">
            {trigger(run)} · <span className="font-mono">{run.sha.slice(0, 12)}</span>
            {run.actor ? ` · by ${run.actor}` : ''} · {ago(run.created)}
            {run.started ? ` · ${duration(run.started, run.finished)}` : ''}
          </p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            {active ? (
              <button
                type="button"
                disabled={acting}
                onClick={() => act(() => api.cancelRun(repoPath, number).then(load))}
                className="px-3 py-1.5 rounded text-xs font-medium border border-border-subtle text-txt-primary hover:bg-surface-subtle inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <Ban className="w-3.5 h-3.5" /> Cancel run
              </button>
            ) : (
              <button
                type="button"
                disabled={acting}
                onClick={() => act(() => api.rerunRun(repoPath, number).then(r => onOpenRun(r.number)))}
                className="px-3 py-1.5 rounded text-xs font-medium border border-border-subtle text-txt-primary hover:bg-surface-subtle inline-flex items-center gap-1.5 disabled:opacity-50"
              >
                <RotateCcw className="w-3.5 h-3.5" /> Re-run
              </button>
            )}
          </div>
        )}
      </div>
      {(run.error || error) && (
        <p role="alert" className="text-sm text-feedback-error-text">
          {run.error || error}
        </p>
      )}
      {Object.keys(run.inputs || {}).length > 0 && (
        <p className="text-xs text-txt-secondary font-mono">
          {Object.entries(run.inputs).map(([k, v]) => `${k}=${v}`).join('  ')}
        </p>
      )}

      {jobs.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-[220px_minmax(0,1fr)] gap-6 min-w-0">
          <nav aria-label="Jobs" className="space-y-1 min-w-0">
            <h4 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider mb-2">Jobs</h4>
            {jobs.map(j => (
              <button
                key={j.id}
                type="button"
                onClick={() => setJobId(j.id)}
                className={`w-full text-left px-2 py-1.5 rounded text-sm flex items-center gap-2 min-w-0 ${j.id === jobId ? 'bg-surface-subtle text-txt-primary font-medium' : 'text-txt-secondary hover:text-txt-primary'}`}
              >
                <RunStatusIcon status={j.status} conclusion={j.conclusion} className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1">{j.name}</span>
                {j.started && <span className="text-[11px] font-mono text-txt-tertiary">{duration(j.started, j.finished)}</span>}
              </button>
            ))}
          </nav>
          {job && <JobLog key={job.id} repoPath={repoPath} runNumber={number} job={job} />}
        </div>
      )}
    </div>
  );
};

const JobLog: React.FC<{
  repoPath: string;
  runNumber: number;
  job: WorkflowJob;
}> = ({ repoPath, runNumber, job }) => {
  const [stored, setStored] = useState<string | null>(null);
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const bottom = useRef<HTMLDivElement>(null);
  const done = job.status === 'completed';

  // The server flushes a running job's log every ~1.5s; poll it while the job
  // runs, and fetch once more when it completes.
  useEffect(() => {
    let alive = true;
    const fetchLog = () =>
      api
        .getJobLog(repoPath, runNumber, job.id)
        .then(t => alive && setStored(t))
        .catch(() => alive && setStored(prev => prev ?? ''));
    void fetchLog();
    const timer = done ? null : setInterval(() => void fetchLog(), 2000);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [repoPath, runNumber, job.id, done]);

  const sections = useMemo(() => splitLog(stored || ''), [stored]);

  // Open the running or failed step by default.
  const focus = job.steps.findIndex(s => s.status === 'running' || s.conclusion === 'failure');
  const isOpen = (i: number) => open[i] ?? (i === focus || (focus < 0 && i === -1 && job.conclusion === 'failure'));

  const rows: { idx: number; name: string; status: string; conclusion: string | null; started?: number | null; finished?: number | null }[] = [
    { idx: -1, name: 'Set up job', status: job.started ? 'completed' : job.status, conclusion: job.started ? 'success' : null },
    ...job.steps.map((s, i) => ({ idx: i, ...s })),
    ...(sections.has(job.steps.length) ? [{ idx: job.steps.length, name: 'Complete job', status: 'completed', conclusion: 'success' }] : []),
  ];

  useEffect(() => {
    if (!done) bottom.current?.scrollIntoView?.({ block: 'nearest' });
  }, [stored, done]);

  return (
    <section aria-label={`Log for ${job.name}`} className="min-w-0 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-txt-primary truncate">{job.name}</h4>
        {job.image && <span className="text-[11px] font-mono text-txt-tertiary truncate">{job.image}</span>}
      </div>
      <div className="rounded border border-border-subtle bg-surface-base overflow-hidden">
        {rows.map(r => {
          const lines = sections.get(r.idx) || [];
          const expanded = isOpen(r.idx);
          return (
            <div key={r.idx} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setOpen(o => ({ ...o, [r.idx]: !expanded }))}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface-subtle/60"
              >
                {expanded ? <ChevronDown className="w-3.5 h-3.5 text-txt-tertiary" /> : <ChevronRight className="w-3.5 h-3.5 text-txt-tertiary" />}
                <RunStatusIcon status={r.status} conclusion={r.conclusion} className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate flex-1 text-txt-primary">{r.name}</span>
                {r.started ? <span className="text-[11px] font-mono text-txt-tertiary">{duration(r.started, r.finished)}</span> : null}
              </button>
              {expanded && (
                <pre className="px-3 pb-3 text-[12px] leading-5 font-mono text-txt-secondary overflow-x-auto whitespace-pre">
                  {lines.length === 0 ? (
                    <span className="text-txt-tertiary">{stored === null ? 'Loading...' : 'No output'}</span>
                  ) : (
                    lines.map((l, n) => (
                      <div key={n} className="flex gap-3">
                        <span className="select-none text-txt-tertiary w-8 text-right shrink-0">{n + 1}</span>
                        <span>{stripAnsi(l)}</span>
                      </div>
                    ))
                  )}
                </pre>
              )}
            </div>
          );
        })}
      </div>
      <div ref={bottom} />
    </section>
  );
};

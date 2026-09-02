// Deployments — Docker app services per repo: creation wizard (root-dir +
// detected Dockerfiles), lifecycle management, live build/release logs,
// HTTP request logs, env vars, CPU/RAM usage, uptime charts, and domains.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronLeft,
  CircleDot,
  Copy,
  Cpu,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Loader2,
  MemoryStick,
  Play,
  Plus,
  RotateCcw,
  Rocket,
  ScrollText,
  Settings as SettingsIcon,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import {
  api,
  DeployService,
  DeploymentRecord,
  DeploymentDetail,
  DomainEntry,
  EnvVarInfo,
  HttpLogsResponse,
  StatsSnapshot,
  UptimeResponse,
} from '../lib/api';
import { DeployEvent, subscribeDeployEvents } from '../lib/deployEvents';

// ---------------------------------------------------------------------------
// Small shared pieces
// ---------------------------------------------------------------------------

const STATUS_TONE: Record<string, string> = {
  running: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
  live: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/30',
  idle: 'text-txt-secondary bg-surface-subtle border-border-subtle',
  stopped: 'text-zinc-400 bg-zinc-400/10 border-zinc-400/30',
  deploying: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
  building: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
  releasing: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
  queued: 'text-sky-400 bg-sky-400/10 border-sky-400/30',
  failed: 'text-red-400 bg-red-400/10 border-red-400/30',
  cancelled: 'text-amber-400 bg-amber-400/10 border-amber-400/30',
};

export const StatusPill: React.FC<{ status: string; className?: string }> = ({ status, className = '' }) => (
  <span
    data-status={status}
    className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded-full border ${
      STATUS_TONE[status] || STATUS_TONE.idle
    } ${className}`}
  >
    {status === 'deploying' && <Loader2 className="w-3 h-3 animate-spin" />}
    {status}
  </span>
);

export const UptimeStrip: React.FC<{
  buckets: { state: string; latency_ms?: number | null }[];
  className?: string;
}> = ({ buckets, className = '' }) => (
  <div className={`flex gap-[2px] items-stretch h-5 ${className}`} aria-label="uptime strip">
    {buckets.map((b, i) => (
      <div
        key={i}
        title={`${b.state}${b.latency_ms != null ? ` · ${b.latency_ms}ms` : ''}`}
        className={`flex-1 rounded-[2px] min-w-[3px] ${
          b.state === 'up'
            ? 'bg-emerald-500/80'
            : b.state === 'down'
              ? 'bg-red-500'
              : 'bg-surface-subtle'
        }`}
      />
    ))}
  </div>
);

export const UsageBar: React.FC<{ icon: React.ReactNode; label: string; pct: number | null; detail: string }> = ({
  icon,
  label,
  pct,
  detail,
}) => {
  const shown = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const tone = pct == null ? 'bg-surface-subtle' : pct > 90 ? 'bg-red-500' : pct > 70 ? 'bg-amber-400' : 'bg-emerald-500';
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="flex items-center gap-1.5 text-txt-secondary">
          {icon}
          {label}
        </span>
        <span className="font-mono text-txt-secondary">{detail}</span>
      </div>
      <div className="h-1.5 rounded-full bg-surface-subtle overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-500 ${tone}`} style={{ width: `${shown}%` }} />
      </div>
    </div>
  );
};

const CopyButton: React.FC<{ text: string; label?: string }> = ({ text, label }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1200);
          },
          () => {},
        );
      }}
      className="inline-flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary"
      title="Copy"
    >
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
      {label || ''}
    </button>
  );
};

const fmtBytes = (n: number): string => {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(n % (1024 ** 3) ? 1 : 0)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
};
const fmtDur = (ms: number | null | undefined): string =>
  ms == null ? '' : ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;

// ---------------------------------------------------------------------------
// Create wizard: root dir -> detect Dockerfiles -> pick + configure.
// ---------------------------------------------------------------------------

interface WizardProps {
  onCreated: (svc: DeployService) => void;
  defaultBranch: string;
}

const CreateWizard: React.FC<WizardProps> = ({ onCreated, defaultBranch }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [name, setName] = useState('');
  const [rootDir, setRootDir] = useState('.');
  const [branch, setBranch] = useState(defaultBranch);
  const [detected, setDetected] = useState<string[] | null>(null);
  const [dockerfile, setDockerfile] = useState('');
  const [port, setPort] = useState('8080');
  const [cpuCores, setCpuCores] = useState('1');
  const [memoryMb, setMemoryMb] = useState('512');
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [envPairs, setEnvPairs] = useState<Array<{ key: string; value: string }>>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const detect = async () => {
    setError('');
    try {
      const res = await api.detectDockerfiles(space!, repoUid!, rootDir, branch);
      setDetected(res.dockerfiles.map(d => d.file));
      setDockerfile(res.dockerfiles[0]?.file || '');
    } catch (err) {
      setDetected([]);
      setDockerfile('');
      setError((err as Error).message);
    }
  };

  const submit = async () => {
    setError('');
    setBusy(true);
    try {
      const svc = await api.createDeployService(space!, repoUid!, {
        name: name || dockerfile.replace(/^.*\//, '').replace(/Dockerfile/i, 'app'),
        root_dir: rootDir,
        dockerfile_path: dockerfile,
        branch,
        container_port: Number(port),
        cpu_cores: Number(cpuCores),
        memory_mb: Number(memoryMb),
        auto_deploy: autoDeploy,
        env: Object.fromEntries(envPairs.filter(p => p.key).map(p => [p.key, p.value])),
      });
      onCreated(svc);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const inputCls =
    'bg-surface-base border border-border-subtle rounded-md px-3 py-2 text-sm w-full focus:outline-none focus:border-brand text-txt-primary placeholder:text-txt-tertiary';

  return (
    <div className="border border-border-subtle rounded-lg p-6 max-w-2xl mx-auto mt-8 space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-txt-primary flex items-center gap-2">
          <Rocket className="w-5 h-5 text-brand" /> New deployment service
        </h2>
        <p className="text-xs text-txt-secondary mt-1">
          Pick a directory inside this repo (monorepo-friendly) and deploy an existing Dockerfile — Nixre never invents the build for you.
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-txt-secondary">Service name</span>
          <input className={inputCls} placeholder="web" value={name} onChange={e => setName(e.target.value)} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-txt-secondary">Watched branch</span>
          <input className={inputCls} value={branch} onChange={e => setBranch(e.target.value)} />
        </label>
      </div>

      <div className="space-y-1">
        <span className="text-xs font-medium text-txt-secondary">Root directory in repo</span>
        <div className="flex gap-2">
          <input className={inputCls} placeholder="apps/web or ." value={rootDir} onChange={e => setRootDir(e.target.value)} />
          <button type="button" onClick={detect} className="px-3 py-2 text-xs font-medium rounded-md bg-brand/10 text-brand border border-brand/30 hover:bg-brand/20 shrink-0">
            Detect Dockerfiles
          </button>
        </div>
      </div>

      {detected !== null && (
        <div className="space-y-1" data-testid="dockerfile-detection">
          {detected.length === 0 ? (
            <p className="text-xs text-red-400">No Dockerfile found under that directory — add one to the repo first.</p>
          ) : (
            <>
              <span className="text-xs font-medium text-txt-secondary">Dockerfile</span>
              <select className={inputCls} value={dockerfile} onChange={e => setDockerfile(e.target.value)}>
                {detected.map(d => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-txt-secondary">Container port</span>
          <input className={inputCls} inputMode="numeric" value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ''))} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-txt-secondary">CPU limit (cores)</span>
          <input className={inputCls} inputMode="decimal" value={cpuCores} onChange={e => setCpuCores(e.target.value.replace(/[^\d.]/g, ''))} />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-txt-secondary">RAM limit (MB)</span>
          <input className={inputCls} inputMode="numeric" value={memoryMb} onChange={e => setMemoryMb(e.target.value.replace(/\D/g, ''))} />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm text-txt-secondary">
        <input type="checkbox" checked={autoDeploy} onChange={e => setAutoDeploy(e.target.checked)} className="accent-[var(--brand)]" />
        Auto-deploy when commits land on <code className="font-mono text-txt-primary">{branch}</code>
      </label>

      <EnvPairEditor pairs={envPairs} onChange={setEnvPairs} />

      {error && <p className="text-xs text-red-400 break-words" role="alert">{error}</p>}

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          disabled={busy || !dockerfile}
          onClick={submit}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md bg-brand text-white hover:opacity-90 disabled:opacity-40"
        >
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Create service
        </button>
      </div>
    </div>
  );
};

const EnvPairEditor: React.FC<{
  pairs: Array<{ key: string; value: string }>;
  onChange: (pairs: Array<{ key: string; value: string }>) => void;
}> = ({ pairs, onChange }) => {
  const input =
    'bg-surface-base border border-border-subtle rounded px-2 py-1.5 text-xs font-mono w-full text-txt-primary';
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-txt-secondary flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5" /> Environment variables
        </span>
        <button type="button" onClick={() => onChange([...pairs, { key: '', value: '' }])} className="text-xs text-brand hover:underline flex items-center gap-1">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
      {pairs.map((pair, i) => (
        <div key={i} className="flex gap-2 items-center">
          <input className={input} placeholder="KEY" value={pair.key} onChange={e => { const next = [...pairs]; next[i] = { ...next[i], key: e.target.value }; onChange(next); }} />
          <input className={input} placeholder="value" type="password" value={pair.value} onChange={e => { const next = [...pairs]; next[i] = { ...next[i], value: e.target.value }; onChange(next); }} />
          <button type="button" onClick={() => onChange(pairs.filter((_, j) => j !== i))} className="text-txt-tertiary hover:text-red-400 shrink-0">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ))}
      {pairs.length === 0 && <p className="text-[11px] text-txt-tertiary">Injected into the container at deploy time.</p>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// HTTP logs panel
// ---------------------------------------------------------------------------

const CLASS_ORDER = ['2xx', '3xx', '4xx', '5xx', 'none'] as const;

const HttpLogsPanel: React.FC<{ service: DeployService }> = ({ service }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [data, setData] = useState<HttpLogsResponse | null>(null);
  const [cls, setCls] = useState<string | null>('4xx');
  const [q, setQ] = useState('');
  const [showFailuresOnly, setShowFailuresOnly] = useState(true);

  const load = useCallback(async () => {
    try {
      setData(
        await api.httpLogs(space!, repoUid!, service.id, {
          class: cls || undefined,
          q: q || undefined,
          limit: 300,
        }),
      );
    } catch {
      /* transient */
    }
  }, [space, repoUid, service.id, cls, q]);

  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => {
    if (!data) return [];
    return showFailuresOnly && cls == null ? data.logs.filter(l => l.status_code == null || l.status_code >= 400) : data.logs;
  }, [data, cls, showFailuresOnly]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={() => setCls(null)}
          className={`text-[11px] font-mono px-2 py-1 rounded-md border transition ${cls === null ? 'border-brand text-brand bg-brand/10' : 'border-border-subtle text-txt-secondary hover:text-txt-primary'}`}
        >
          All
        </button>
        {CLASS_ORDER.filter(c => c !== 'none').map(c => (
          <button
            key={c}
            onClick={() => setCls(c === cls ? null : c)}
            data-class={c}
            className={`text-[11px] font-mono px-2 py-1 rounded-md border transition ${
              cls === c
                ? c === '4xx' || c === '5xx'
                  ? 'border-red-400 text-red-300 bg-red-400/10'
                  : 'border-brand text-brand bg-brand/10'
                : 'border-border-subtle text-txt-secondary hover:text-txt-primary'
            }`}
          >
            {c} · {data?.counts_24h[c] ?? 0}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-1.5 text-xs text-txt-secondary">
          <input type="checkbox" checked={showFailuresOnly} onChange={e => setShowFailuresOnly(e.target.checked)} className="accent-[var(--brand)]" />
          highlight failures
        </label>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="filter by path…"
          className="bg-surface-base border border-border-subtle rounded-md px-2.5 py-1.5 text-xs w-44 text-txt-primary"
        />
      </div>

      <div className="rounded-lg border border-border-subtle overflow-hidden">
        <table className="w-full text-left text-xs font-mono divide-y divide-border-subtle">
          <thead className="bg-surface-subtle text-txt-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">time</th>
              <th className="px-3 py-2 font-medium">method</th>
              <th className="px-3 py-2 font-medium">path</th>
              <th className="px-3 py-2 font-medium">status</th>
              <th className="px-3 py-2 font-medium text-right">duration</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(l => {
              const failed = l.status_code == null || l.status_code >= 400;
              return (
                <tr key={l.id} className={`hover:bg-surface-subtle/60 ${failed ? 'bg-red-500/[0.04]' : ''}`}>
                  <td className="px-3 py-1.5 text-txt-tertiary whitespace-nowrap">{new Date(l.ts).toLocaleTimeString()}</td>
                  <td className="px-3 py-1.5 text-txt-secondary">{l.method}</td>
                  <td className="px-3 py-1.5 truncate max-w-[420px]" title={l.path}>{l.path}</td>
                  <td className={`px-3 py-1.5 font-semibold ${failed ? 'text-red-400' : 'text-emerald-400'}`}>{l.status_code ?? 'ERR'}</td>
                  <td className="px-3 py-1.5 text-right text-txt-secondary">{fmtDur(l.duration_ms)}</td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-txt-tertiary">
                  No requests captured yet{data ? '' : ' (loading…)'}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {data && (
        <p className="text-[11px] text-txt-tertiary">
          Retention: failures ≥ <span className="font-mono">{data.preserve.preserve_status_min}</span> kept{' '}
          {data.preserve.failure_retention_hours}h · other responses kept {data.preserve.success_retention_hours}h.
        </p>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Domains panel
// ---------------------------------------------------------------------------

const DomainsPanel: React.FC<{ service: DeployService }> = ({ service }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<'caddy' | 'tunnel'>('caddy');
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.listDomains(space!, repoUid!, service.id).then(setDomains).catch(() => {});
  }, [space, repoUid, service.id]);
  useEffect(load, [load]);

  const add = async () => {
    setErr('');
    try {
      await api.addDomain(space!, repoUid!, service.id, draft.trim(), kind);
      setDraft('');
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const remove = async (d: DomainEntry) => {
    setErr('');
    try {
      const res = await api.removeDomain(space!, repoUid!, service.id, d.id);
      if (res?.dns && !res.dns.removed && res.dns.error) {
        setErr(`Domain detached, but its Cloudflare DNS record could not be removed: ${res.dns.error}`);
      }
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const retryDns = async (d: DomainEntry) => {
    setErr('');
    try {
      await api.retryDomainDns(space!, repoUid!, service.id, d.id);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && draft.trim() && add()}
          placeholder="app.yourdomain.com"
          className="bg-surface-base border border-border-subtle rounded-md px-3 py-2 text-sm flex-1 min-w-[220px] text-txt-primary"
        />
        <select value={kind} onChange={e => setKind(e.target.value as 'caddy' | 'tunnel')} className="bg-surface-base border border-border-subtle rounded-md px-2 text-sm text-txt-primary">
          <option value="caddy">Host Caddy / Nginx</option>
          <option value="tunnel">Cloudflare Tunnel</option>
        </select>
        <button onClick={add} disabled={!draft.trim()} className="px-3 py-2 text-xs font-medium rounded-md bg-brand/10 text-brand border border-brand/30 hover:bg-brand/20 disabled:opacity-40 inline-flex items-center gap-1">
          <Globe className="w-3.5 h-3.5" /> Attach domain
        </button>
      </div>
      {err && <p className="text-xs text-red-400" role="alert">{err}</p>}

      {domains.length === 0 && (
        <p className="text-xs text-txt-tertiary">
          No custom domains yet. Until then you can reach this app at
          <code className="mx-1 font-mono text-txt-secondary">{`${service.name}.<DEPLOY_BASE_DOMAIN>`}</code>
          or <code className="font-mono text-txt-secondary">{`svc-${service.id}.<DEPLOY_BASE_DOMAIN>`}</code> if configured.
        </p>
      )}

      {domains.map(d => {
        const dns = d.dns || { auto: false, status: 'manual' as const };
        const autoCreated = dns.auto && dns.status === 'created';
        return (
        <div key={d.id} className="border border-border-subtle rounded-lg p-4 space-y-3" data-testid="domain-card">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <Globe className="w-4 h-4 text-brand" />
              <span className="font-mono text-sm text-txt-primary">{d.domain}</span>
              <span className="text-[10px] uppercase tracking-wide font-mono text-txt-tertiary border border-border-subtle rounded px-1.5 py-0.5">{d.kind}</span>
              {dns.auto && dns.status === 'created' && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-green-500 border border-green-500/30 bg-green-500/10 rounded px-1.5 py-0.5" data-testid="dns-auto-badge">
                  <Check className="w-3 h-3" /> DNS record auto-managed
                </span>
              )}
              {dns.auto && dns.status === 'failed' && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-red-400 border border-red-400/30 bg-red-400/10 rounded px-1.5 py-0.5">
                  <AlertTriangle className="w-3 h-3" /> DNS creation failed
                </span>
              )}
              {dns.auto && dns.status === 'pending' && (
                <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400 border border-amber-400/30 bg-amber-400/10 rounded px-1.5 py-0.5">
                  <AlertTriangle className="w-3 h-3" /> DNS record pending
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {dns.auto && (dns.status === 'failed' || dns.status === 'pending') && (
                <button
                  onClick={() => retryDns(d)}
                  className="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-border-subtle text-txt-secondary hover:text-txt-primary hover:border-txt-tertiary"
                >
                  <RotateCcw className="w-3 h-3" /> Retry DNS
                </button>
              )}
              <button
                onClick={() => remove(d)}
                className="text-txt-tertiary hover:text-red-400"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>

          {dns.auto && dns.status === 'failed' && dns.error && (
            <p className="text-xs text-red-400 font-mono" role="alert">{dns.error}</p>
          )}

          {autoCreated ? (
            <div className="text-xs space-y-1" data-testid="dns-auto-note">
              <p className="text-green-500">
                CNAME <span className="font-mono">{d.domain}</span> → <span className="font-mono">{dns.target}</span>{' '}
                (proxied) was created automatically via the Cloudflare API
                {dns.zone ? ` in zone ${dns.zone}` : ''}{dns.existed ? ' — reused the existing record' : ''}. Nothing to do at your registrar.
              </p>
              <p className="text-[11px] text-txt-tertiary">
                Deleting this domain removes the record again. New records can take ~1 minute to become active on Cloudflare's edge.
              </p>
            </div>
          ) : (
            <>
              <div>
                <p className="text-[11px] font-medium text-txt-secondary uppercase tracking-wide mb-1.5">Add these records at your DNS registrar</p>
                <table className="w-full text-xs font-mono border border-border-subtle rounded divide-y divide-border-subtle">
                  <tbody>
                    {d.guidance.dns.map((rec, i) => (
                      <tr key={i}>
                        <td className="px-2.5 py-1.5 text-txt-secondary">{rec.type}</td>
                        <td className="px-2.5 py-1.5">{rec.name}</td>
                        <td className="px-2.5 py-1.5 text-txt-secondary">
                          → {rec.target}
                          <CopyButton text={rec.target} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {d.guidance.notes?.length ? (
                <ul className="list-disc pl-5 text-[11px] text-txt-tertiary space-y-0.5">
                  {d.guidance.notes.map((n, i) => (
                    <li key={i} className="whitespace-pre-wrap font-mono">{n}</li>
                  ))}
                </ul>
              ) : null}

              {d.guidance.cloudflared_ingress && (
                <pre className="bg-surface-subtle rounded p-2.5 text-[11px] font-mono overflow-x-auto text-txt-secondary">
                  {JSON.stringify(d.guidance.cloudflared_ingress, null, 2)}
                  <CopyButton text={JSON.stringify(d.guidance.cloudflared_ingress, null, 2)} />
                </pre>
              )}
              {d.guidance.caddy_snippet && (
                <pre className="bg-surface-subtle rounded p-2.5 text-[11px] font-mono overflow-x-auto text-txt-secondary">
                  {d.guidance.caddy_snippet}{' '}
                  <CopyButton text={d.guidance.caddy_snippet} />
                </pre>
              )}
            </>
          )}
        </div>
        );
      })}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Deployments history tab + live logs modal
// ---------------------------------------------------------------------------

const DeploysPanel: React.FC<{ service: DeployService; onChanged: () => void }> = ({ service, onChanged }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [history, setHistory] = useState<DeploymentRecord[]>([]);
  const [detail, setDetail] = useState<DeploymentDetail | null>(null);
  const [refInput, setRefInput] = useState('');

  const load = useCallback(() => {
    api.listDeployments(space!, repoUid!, service.id).then(setHistory).catch(() => {});
  }, [space, repoUid, service.id]);
  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    await fn().catch(() => {});
    load();
    onChanged();
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <input
          value={refInput}
          onChange={e => setRefInput(e.target.value)}
          placeholder={`${service.branch} (or sha/tag)`}
          className="bg-surface-base border border-border-subtle rounded-md px-3 py-1.5 text-xs font-mono w-64 text-txt-primary"
        />
        <button
          onClick={() => act(() => api.deployService(space!, repoUid!, service.id, refInput.trim() || undefined))}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:opacity-90 inline-flex items-center gap-1.5"
        >
          <Rocket className="w-3.5 h-3.5" /> Deploy
        </button>
      </div>

      <div className="rounded-lg border border-border-subtle overflow-hidden">
        <table className="w-full text-left text-xs divide-y divide-border-subtle">
          <thead className="bg-surface-subtle text-txt-secondary">
            <tr>
              <th className="px-3 py-2 font-medium">#</th>
              <th className="px-3 py-2 font-medium">commit</th>
              <th className="px-3 py-2 font-medium">trigger</th>
              <th className="px-3 py-2 font-medium">status</th>
              <th className="px-3 py-2 font-medium">when</th>
              <th className="px-3 py-2 font-medium text-right">actions</th>
            </tr>
          </thead>
          <tbody>
            {history.map(d => (
              <tr key={d.id} className={`hover:bg-surface-subtle/60 ${d.serving ? 'bg-emerald-500/[0.04]' : ''}`}>
                <td className="px-3 py-2 font-mono text-txt-tertiary">{d.id}</td>
                <td className="px-3 py-2 max-w-[280px]">
                  <span className="font-mono text-txt-primary">{d.short_sha}</span>
                  <span className="ml-2 text-txt-tertiary truncate inline-block align-bottom max-w-[190px]">{d.message}</span>
                </td>
                <td className="px-3 py-2 text-txt-secondary font-mono text-[11px]">{d.trigger}</td>
                <td className="px-3 py-2"><StatusPill status={d.status} /></td>
                <td className="px-3 py-2 text-txt-tertiary whitespace-nowrap">{new Date(d.started).toLocaleString()}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button
                    onClick={() =>
                      api.getDeployment(space!, repoUid!, service.id, d.id).then(rec => setDetail(rec))
                    }
                    className="mr-2 text-txt-secondary hover:text-txt-primary inline-flex items-center gap-1"
                  >
                    <ScrollText className="w-3.5 h-3.5" /> Logs
                  </button>
                  {!d.serving && d.status === 'live' && (
                    <>
                      <button onClick={() => act(() => api.rollbackDeployment(space!, repoUid!, service.id, d.id))} className="mr-2 text-txt-secondary hover:text-brand inline-flex items-center gap-1" title="Roll back to this release">
                        <RotateCcw className="w-3.5 h-3.5" /> Rollback
                      </button>
                      <button
                        onClick={() => window.confirm(`Delete deployment #${d.id}?`) && act(() => api.deleteDeploymentRecord(space!, repoUid!, service.id, d.id))}
                        className="text-txt-tertiary hover:text-red-400"
                        title="Delete record"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  {!d.serving && (d.status === 'failed' || d.status === 'cancelled') && (
                    <>
                      <button onClick={() => act(() => api.redeployDeployment(space!, repoUid!, service.id, d.id))} className="mr-2 text-txt-secondary hover:text-brand inline-flex items-center gap-1" title="Redeploy same commit">
                        <RotateCcw className="w-3.5 h-3.5" /> Redeploy
                      </button>
                      <button
                        onClick={() => window.confirm(`Delete deployment #${d.id}?`) && act(() => api.deleteDeploymentRecord(space!, repoUid!, service.id, d.id))}
                        className="text-txt-tertiary hover:text-red-400"
                        title="Delete record"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </>
                  )}
                  {['building', 'releasing', 'queued'].includes(d.status) && (
                    <button onClick={() => act(() => api.cancelDeploymentRun(space!, repoUid!, service.id))} className="text-amber-400 hover:text-amber-300 inline-flex items-center gap-1">
                      <Square className="w-3 h-3" /> Cancel
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-txt-tertiary">
                  Nothing deployed yet — hit Deploy above or push to <span className="font-mono">{service.branch}</span>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {detail && <LogViewer detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
};

const LogViewer: React.FC<{ detail: DeploymentDetail; onClose: () => void }> = ({ detail, onClose }) => (
  <div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" onClick={onClose}>
    <div className="bg-surface-base border border-border-subtle rounded-xl w-full max-w-4xl max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div className="text-sm text-txt-primary">
          Deployment <span className="font-mono">#{detail.id}</span> — <span className="font-mono">{detail.short_sha}</span>{' '}
          <StatusPill status={detail.status} className="ml-2" />
        </div>
        <button onClick={onClose} className="text-txt-tertiary hover:text-txt-primary"><X className="w-4 h-4" /></button>
      </div>
      <div className="overflow-auto p-4 text-[11px] font-mono leading-relaxed whitespace-pre-wrap text-txt-secondary flex-1 bg-black/20">
        {(detail.error ? `ERROR: ${detail.error}\n\n` : '') + (detail.build_log || '(no build output recorded)')}
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Service detail (overview / env / settings)
// ---------------------------------------------------------------------------

type Tab = 'overview' | 'deploys' | 'logs' | 'env' | 'domains';

const ServiceDetail: React.FC<{ service: DeployService; onChanged: () => void; onDeleted: () => void }> = ({
  service,
  onChanged,
  onDeleted,
}) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [tab, setTab] = useSearchParamsTabDefault();

  const triggerRefresh = onChanged;

  useEffect(() => subscribeDeployEvents(space!, repoUid!, service.id, (evt: DeployEvent) => {
    if (evt.type === 'status') triggerRefresh();
  }), [space, repoUid, service.id, triggerRefresh]);

  const busyNow = ['queued', 'building', 'releasing'].includes(service.status);
  const lastFailedId = service.last_failed_deployment_id;

  return (
    <div className="space-y-5 mt-6">
      <Link to={`/${space}/${repoUid}/deployments`} className="inline-flex items-center gap-1 text-xs text-txt-secondary hover:text-txt-primary">
        <ChevronLeft className="w-3.5 h-3.5" /> All services
      </Link>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <Rocket className="w-5 h-5 text-brand shrink-0" />
          <div className="min-w-0">
            <h1 className="text-xl font-bold text-txt-primary truncate flex items-center gap-2.5">
              {service.name}
              <StatusPill status={service.desired_state === 'stopped' ? 'stopped' : service.status} />
              {service.current?.short_sha && <span className="font-mono text-xs text-txt-tertiary">{service.current.short_sha}</span>}
            </h1>
            <p className="text-xs text-txt-secondary truncate">
              {service.root_dir === '.' ? 'repo root' : service.root_dir}/<span className="font-mono">{service.dockerfile_path}</span> · port {service.container_port} · {(Number(service.cpu_nano_cpus) / 1e9).toFixed(1)} cores · {fmtBytes(Number(service.memory_bytes))}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          {busyNow ? (
            <button onClick={() => api.cancelDeploymentRun(space!, repoUid!, service.id).then(triggerRefresh)} className="px-3 py-1.5 text-xs rounded-md border border-amber-400/40 text-amber-400 hover:bg-amber-400/10 inline-flex items-center gap-1.5">
              <Square className="w-3 h-3" /> Cancel run
            </button>
          ) : service.desired_state === 'stopped' ? (
            <button onClick={() => api.patchDeployService(space!, repoUid!, service.id, { desired_state: 'running' }).then(triggerRefresh)} className="px-3 py-1.5 text-xs rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-400/30 hover:bg-emerald-500/25 inline-flex items-center gap-1.5">
              <Play className="w-3 h-3" /> Start
            </button>
          ) : (
            <button onClick={() => api.patchDeployService(space!, repoUid!, service.id, { desired_state: 'stopped' }).then(triggerRefresh)} className="px-3 py-1.5 text-xs rounded-md border border-border-subtle text-txt-secondary hover:text-txt-primary inline-flex items-center gap-1.5">
              <Square className="w-3 h-3" /> Stop
            </button>
          )}
          {!busyNow && (
            <button onClick={() => api.deployService(space!, repoUid!, service.id).then(triggerRefresh)} className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:opacity-90 inline-flex items-center gap-1.5">
              <Rocket className="w-3.5 h-3.5" /> Deploy latest
            </button>
          )}
        </div>
      </div>

      {lastFailedId != null && (
        <div className="border border-red-500/50 bg-red-500/10 rounded-lg px-4 py-3 flex items-start gap-3" data-testid="failure-banner" role="alert">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <div className="text-sm text-red-200">
            <strong className="text-red-300">Warning: deployment #{lastFailedId} failed.</strong>{' '}
            {service.current_deployment_id ? (
              <>Traffic is still served by the previous healthy release (#{service.current_deployment_id}).</>
            ) : (
              <>No release is being served right now.</>
            )}{' '}
            Inspect the failed build under <em>Deployments</em>, fix, then redeploy or roll back explicitly.
          </div>
        </div>
      )}

      <div className="flex gap-1 border-b border-border-subtle -mt-1">
        {(['overview', 'deploys', 'logs', 'env', 'domains'] as Tab[]).map(t => (
          <button
            key={t}
            data-tab={t}
            onClick={() => setTab(t)}
            className={`px-3.5 py-2 text-xs font-medium capitalize border-b-2 -mb-px transition ${
              tab === t ? 'border-brand text-txt-primary font-semibold' : 'border-transparent text-txt-secondary hover:text-txt-primary'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && <OverviewTab service={service} />}
      {tab === 'deploys' && <DeploysPanel service={service} onChanged={triggerRefresh} />}
      {tab === 'logs' && <HttpLogsPanel service={service} />}
      {tab === 'env' && <EnvPanel service={service} onChanged={triggerRefresh} />}
      {tab === 'domains' && <DomainsPanel service={service} />}

      <DangerZone service={service} onDeleted={onDeleted} />
    </div>
  );
};

function useSearchParamsTabDefault(): [string, (t: Tab) => void] {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || 'overview';
  const set = (t: Tab) => setParams(prev => {
    const next = new URLSearchParams(prev);
    next.set('tab', t);
    return next;
  });
  return [tab, set];
}

const OverviewTab: React.FC<{ service: DeployService }> = ({ service }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [uptime, setUptime] = useState<UptimeResponse | null>(null);

  useEffect(() => {
    const load = () => {
      api.serviceStats(space!, repoUid!, service.id).then(setStats).catch(() => {});
      api.serviceUptime(space!, repoUid!, service.id, '24h').then(setUptime).catch(() => {});
    };
    load();
    return subscribeDeployEvents(space!, repoUid!, service.id, evt => {
      if (evt.type === 'metrics' && evt.metrics && stats) {
        setStats({
          ...stats,
          latest: { ts: Date.now(), ...evt.metrics },
        });
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space, repoUid, service.id]);

  const memLimit = stats?.limits.memory_bytes ?? Number(service.memory_bytes);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div className="space-y-4">
        <UsageBar
          icon={<Cpu className="w-3.5 h-3.5" />}
          label="CPU (of limit)"
          pct={stats?.latest?.cpuPctOfLimit ?? null}
          detail={stats?.latest ? `${stats.latest.cpuPctOfLimit.toFixed(1)}%` : '—'}
        />
        <UsageBar
          icon={<MemoryStick className="w-3.5 h-3.5" />}
          label="Memory"
          pct={stats?.latest?.memPctOfLimit ?? null}
          detail={stats?.latest ? `${fmtBytes(stats.latest.memUsedBytes)} / ${fmtBytes(memLimit)}` : fmtBytes(memLimit)}
        />
        <div className="flex items-center gap-4 text-xs text-txt-secondary pt-1">
          <span className="flex items-center gap-1.5"><CircleDot className="w-3.5 h-3.5" /> current release:</span>
          {service.current ? (
            <span className="font-mono text-txt-primary">
              #{service.current.id} · {service.current.short_sha || service.current.ref} · {service.current.trigger}
            </span>
          ) : (
            <span className="text-txt-tertiary italic">none yet</span>
          )}
        </div>
        {stats && stats.series.length > 2 && <MiniSeries series={stats.series} />}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 text-txt-secondary"><Activity className="w-3.5 h-3.5" /> Uptime — last 24h</span>
          <span className="font-mono">{uptime?.uptime_pct != null ? `${uptime.uptime_pct.toFixed(1)}%` : '—'}</span>
        </div>
        <UptimeStrip buckets={uptime?.buckets || []} />
        <p className="text-[11px] text-txt-tertiary">Green buckets answered health probes every ~30s; red means the app missed them.</p>
      </div>
    </div>
  );
};

const MiniSeries: React.FC<{ series: { cpuPctOfLimit: number }[] }> = ({ series }) => {
  const pts = series.slice(-40);
  const max = Math.max(10, ...pts.map(p => p.cpuPctOfLimit));
  const bars = pts.map((p, i) => (
    <div key={i} className="flex-1 bg-sky-400/70 rounded-t-[1px]" style={{ height: `${Math.max(4, (p.cpuPctOfLimit / max) * 48)}px` }} title={`${p.cpuPctOfLimit.toFixed(1)}%`} />
  ));
  return (
    <div>
      <p className="text-[11px] text-txt-tertiary mb-1">CPU history (recent samples)</p>
      <div className="flex items-end gap-[2px] h-12">{bars}</div>
    </div>
  );
};

const EnvPanel: React.FC<{ service: DeployService; onChanged: () => void }> = ({ service, onChanged }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [keys, setKeys] = useState<EnvVarInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api.listEnvVars(space!, repoUid!, service.id).then(k => {
      setKeys(k);
      setDirty(false);
      setMsg('');
    });
  }, [space, repoUid, service.id]);
  useEffect(load, [load]);

  const reveal = async (key: string) => {
    if (revealed[key]) {
      setRevealed(r => ({ ...r, [key]: false }));
      return;
    }
    try {
      const out = await api.revealEnvVar(space!, repoUid!, service.id, key);
      setValues(v => ({ ...v, [key]: out.value }));
      setRevealed(r => ({ ...r, [key]: true }));
    } catch {
      /* permission */
    }
  };

  const saveAll = async () => {
    const merged: Record<string, string> = {};
    for (const k of keys) merged[k.key] = revealed[k.key] ? values[k.key] : values[k.key] ?? '';
    for (const [k, v] of Object.entries(drafts)) if (!(k in merged)) merged[k] = v;
    // Only send keys whose values are known plaintext; masked-unmodified ones are re-fetched server-side via reveal flow.
    const explicit: Record<string, string> = {};
    for (const k of keys) {
      if (drafts[k.key] !== undefined) explicit[k.key] = drafts[k.key];
      else if (values[k.key] !== undefined) explicit[k.key] = values[k.key];
    }
    if (Object.keys(explicit).length === 0) {
      setMsg('Nothing changed.');
      return;
    }
    await api.setEnvVars(space!, repoUid!, service.id, explicit);
    setDrafts({});
    setMsg('Saved — takes effect on the next deploy.');
    load();
    onChanged();
  };

  const allKeys = [...new Set([...keys.map(k => k.key), ...Object.keys(drafts)])];

  return (
    <div className="space-y-3 max-w-2xl" data-testid="env-panel">
      <div className="flex items-center justify-between">
        <p className="text-xs text-txt-tertiary">Encrypted at rest · injected at container start · Railway-style groups.</p>
        <button
          onClick={() => setDrafts(d => ({ ...d, [`NEW_${Date.now()}`]: '' }))}
          className="text-xs text-brand hover:underline flex items-center gap-1"
        >
          <Plus className="w-3 h-3" /> Add variable
        </button>
      </div>
      <div className="divide-y divide-border-subtle border border-border-subtle rounded-lg">
        {allKeys.map(key => {
          const isNew = key.startsWith('NEW_');
          return (
            <div key={key} className="flex items-center gap-2 px-3 py-2">
              <span className="font-mono text-xs text-txt-primary w-56 truncate" title={key}>{isNew ? '' : key}</span>
              {isNew ? (
                <input
                  autoFocus
                  placeholder="KEY_NAME"
                  onChange={e => {
                    const val = drafts[key];
                    const next = { ...drafts };
                    delete next[key];
                    if (val !== undefined) next[e.target.value] = val;
                    else next[e.target.value] = '';
                    setDrafts(next);
                  }}
                  className="bg-surface-base border border-border-subtle rounded px-2 py-1 text-xs font-mono w-52 text-txt-primary"
                />
              ) : null}
              <div className="flex-1 flex items-center gap-1.5">
                <input
                  type={revealed[key] ? 'text' : 'password'}
                  placeholder="••••••••"
                  value={drafts[key] ?? (revealed[key] ? values[key] || '' : '')}
                  onChange={e => {
                    setDrafts(d => ({ ...d, [key]: e.target.value }));
                    setDirty(true);
                  }}
                  className="bg-surface-base border border-border-subtle rounded px-2 py-1 text-xs font-mono w-full text-txt-primary"
                />
                {!isNew && (
                  <button onClick={() => reveal(key)} className="text-txt-tertiary hover:text-txt-primary shrink-0" title={revealed[key] ? 'Hide' : 'Reveal'}>
                    {revealed[key] ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                )}
                <button
                  onClick={async () => {
                    if (isNew) {
                      setDrafts(d => {
                        const next = { ...d };
                        delete next[key];
                        return next;
                      });
                      return;
                    }
                    await api.removeEnvVar(space!, repoUid!, service.id, key);
                    load();
                    onChanged();
                  }}
                  className="text-txt-tertiary hover:text-red-400 shrink-0"
                  title="Delete variable"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
        {allKeys.length === 0 && <p className="text-xs text-txt-tertiary px-3 py-4">No variables yet.</p>}
      </div>
      <div className="flex items-center gap-3">
        <button onClick={saveAll} className="px-3 py-1.5 text-xs font-medium rounded-md bg-brand text-white hover:opacity-90">Save changes</button>
        {msg && <span className="text-xs text-txt-secondary">{msg}</span>}
        {dirty && !msg && <span className="text-xs text-amber-400">Unsaved edits</span>}
      </div>
    </div>
  );
};

const DangerZone: React.FC<{ service: DeployService; onDeleted: () => void }> = ({ service, onDeleted }) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  return (
    <div className="border border-red-500/30 rounded-lg p-4 flex items-center justify-between">
      <div>
        <p className="text-sm text-red-300 font-medium">Delete this service</p>
        <p className="text-xs text-txt-tertiary">Removes containers, images, history, and routing for “{service.name}”.</p>
      </div>
      <button
        onClick={async () => {
          if (!window.confirm(`Delete service '${service.name}' and ALL its deployment history?`)) return;
          await api.deleteDeployService(space!, repoUid!, service.id);
          onDeleted();
        }}
        className="px-3 py-1.5 text-xs rounded-md border border-red-500/40 text-red-400 hover:bg-red-500/10 inline-flex items-center gap-1.5 shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" /> Delete service
      </button>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Services list (cards)
// ---------------------------------------------------------------------------

const ServiceCard: React.FC<{ svc: DeployService; onOpen: () => void; onChanged: () => void }> = ({
  svc,
  onOpen,
  onChanged,
}) => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [strip, setStrip] = useState<UptimeResponse | null>(null);
  useEffect(() => {
    api.serviceUptime(space!, repoUid!, svc.id, '24h').then(setStrip).catch(() => {});
  }, [space, repoUid, svc.id]);

  return (
    <div className="border border-border-subtle rounded-lg p-4 space-y-3 hover:border-brand/40 transition cursor-pointer" onClick={onOpen} data-testid={`service-card-${svc.name}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <Rocket className="w-4 h-4 text-brand shrink-0" />
          <span className="font-medium text-txt-primary truncate">{svc.name}</span>
          {svc.alert ? <StatusPill status="failed" /> : <StatusPill status={svc.desired_state === 'stopped' ? 'stopped' : svc.status} />}
        </div>
        {svc.requests_24h != null && <span className="text-[10px] font-mono text-txt-tertiary shrink-0">{svc.requests_24h} req/24h</span>}
      </div>

      {svc.alert && (
        <p className="text-[11px] text-red-400 flex items-center gap-1">
          <AlertTriangle className="w-3 h-3" /> Latest deploy failed — see Deployments tab.
        </p>
      )}

      <UptimeStrip buckets={(strip?.buckets || []).slice(-60)} />

      <div className="flex items-center justify-between text-[11px] text-txt-tertiary font-mono">
        <span>{svc.branch}{svc.auto_deploy ? ' · auto' : ' · manual'}</span>
        <span>{svc.current?.short_sha || 'never deployed'}</span>
      </div>

      <div className="flex gap-2" onClick={e => e.stopPropagation()}>
        {svc.desired_state === 'running' ? (
          <button title="Stop serving" onClick={() => api.patchDeployService(space!, repoUid!, svc.id, { desired_state: 'stopped' }).then(onChanged)} className="text-txt-tertiary hover:text-txt-primary p-1">
            <Square className="w-3.5 h-3.5" />
          </button>
        ) : (
          <button title="Start serving" onClick={() => api.patchDeployService(space!, repoUid!, svc.id, { desired_state: 'running' }).then(onChanged)} className="text-txt-tertiary hover:text-emerald-400 p-1">
            <Play className="w-3.5 h-3.5" />
          </button>
        )}
        <SettingsIconActions name={svc.name} onOpen={onOpen} />
      </div>
    </div>
  );
};

const SettingsIconActions: React.FC<{ name: string; onOpen: () => void }> = ({ name, onOpen }) => (
  <button title={`Configure ${name}`} onClick={onOpen} className="text-txt-tertiary hover:text-txt-primary p-1 ml-auto">
    <SettingsIcon className="w-3.5 h-3.5" />
  </button>
);

// ---------------------------------------------------------------------------
// Page shell
// ---------------------------------------------------------------------------

export const DeploymentsPage: React.FC = () => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const [services, setServices] = useState<DeployService[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [refresh, setRefresh] = useState(0);

  const bump = useCallback(() => setRefresh(n => n + 1), []);

  useEffect(() => {
    api.getRepo(`${space}/${repoUid}`).then(r => setDefaultBranch(r.default_branch || 'main')).catch(() => {});
  }, [space, repoUid]);

  useEffect(() => {
    let alive = true;
    api
      .listDeployServices(space!, repoUid!)
      .then(s => {
        if (!alive) return;
        setServices(s);
        setSelectedId(id => (id != null && s.some(x => x.id === id) ? id : null));
      })
      .catch(() => alive && setServices([]));
    return () => {
      alive = false;
    };
  }, [space, repoUid, refresh]);

  const selected = services?.find(s => s.id === selectedId) || null;

  const header = (
    <div className="mb-6 border-b border-border-subtle pb-5 flex items-start justify-between gap-4">
      <div>
        <Link to={`/${space}/${repoUid}`} className="text-xs text-txt-secondary hover:text-txt-primary inline-flex items-center gap-1 mb-1.5">
          <ChevronLeft className="w-3.5 h-3.5" /> Back to repository
        </Link>
        <h1 className="text-2xl font-bold text-txt-primary flex items-center gap-2.5">
          <Rocket className="w-6 h-6 text-brand" />
          Deployments
          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-subtle text-txt-secondary font-mono border border-border-subtle font-normal">
            {services?.length ?? 0} services
          </span>
        </h1>
        <p className="text-sm text-txt-secondary mt-1">
          Ship any root-directory with its own Dockerfile. Pushes to a watched branch auto-deploy; failures fall back to the last healthy release.
        </p>
      </div>
      {!creating && (
        <button onClick={() => { setCreating(true); setSelectedId(null); }} className="px-3.5 py-2 text-sm font-medium rounded-md bg-brand text-white hover:opacity-90 inline-flex items-center gap-2 shrink-0">
          <Plus className="w-4 h-4" /> New service
        </button>
      )}
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 w-full min-w-0">
      {header}
      {services === null ? (
        <div className="py-16 text-center text-txt-tertiary"><Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />Loading…</div>
      ) : creating ? (
        <CreateWizard
          defaultBranch={defaultBranch}
          onCreated={svc => {
            setCreating(false);
            setSelectedId(svc.id);
            bump();
          }}
        />
      ) : selected ? (
        <ServiceDetail service={selected} onChanged={bump} onDeleted={() => { setSelectedId(null); bump(); }} />
      ) : services.length === 0 ? (
        <div className="text-center py-14 space-y-3">
          <p className="text-txt-secondary">No deployment services on this repository yet.</p>
          <button onClick={() => setCreating(true)} className="px-4 py-2 text-sm rounded-md bg-brand/10 text-brand border border-brand/30 hover:bg-brand/20 inline-flex items-center gap-2">
            <Plus className="w-4 h-4" /> Create your first service
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {services.map(svc => (
            <ServiceCard key={svc.id} svc={svc} onOpen={() => setSelectedId(svc.id)} onChanged={bump} />
          ))}
        </div>
      )}
    </div>
  );
};

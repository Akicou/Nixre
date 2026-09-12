import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Copy, Database, Loader2, Play, RefreshCw, Square } from 'lucide-react';
import { api, DeploymentCapabilities, DeploymentDetail, DeploymentRecord, DeployService, DomainEntry, EnvVarInfo, StatsSnapshot, UptimeResponse } from '../lib/api';
import { subscribeDeployEvents } from '../lib/deployEvents';
import { ENV_KEY_RE } from '../lib/dotenv';

const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-md border border-border-subtle px-3 py-2 text-xs text-txt-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-50';
const inputClass = 'w-full min-w-0 rounded-md border border-border-subtle bg-surface-base px-3 py-2 text-xs text-txt-primary focus:outline-none focus:ring-2 focus:ring-brand disabled:opacity-50';
const busyStatus = (status: string) => ['deploying', 'queued', 'building', 'releasing'].includes(status);

export function StandaloneServiceDetail({ space, serviceId, canWrite, capabilities, onChanged, onDeleted }: {
  space: string;
  serviceId: number;
  canWrite: boolean;
  capabilities?: DeploymentCapabilities;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [service, setService] = useState<DeployService | null>(null);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [dataError, setDataError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const alive = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const [tab, setTab] = useState('Overview');
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const [stats, setStats] = useState<StatsSnapshot | null>(null);
  const [uptime, setUptime] = useState<UptimeResponse | null>(null);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>([]);
  const [deployment, setDeployment] = useState<DeploymentDetail | null>(null);
  const [logs, setLogs] = useState('');
  const [env, setEnv] = useState<EnvVarInfo[]>([]);
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  const [connection, setConnection] = useState('');
  const [envKey, setEnvKey] = useState('');
  const [envValue, setEnvValue] = useState('');
  const writable = canWrite && service?.can_write !== false;
  const postgres = service?.template === 'postgres';
  const deploying = service ? busyStatus(service.status) : false;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { heading.current?.focus(); }, [service?.id]);
  const load = useCallback(async () => {
    try {
      const next = await api.getStandaloneService(space, serviceId);
      if (alive.current) { setService(next); setLoadError(''); }
    } catch (e) { if (alive.current) setLoadError(e instanceof Error ? e.message : 'Unable to load service.'); }
  }, [space, serviceId]);
  const refresh = useCallback(() => { void load(); setRevision(r => r + 1); onChanged(); }, [load, onChanged]);
  useEffect(() => {
    void load();
    const off = subscribeDeployEvents(space, null, serviceId, event => {
      if (event.type === 'status') refresh();
      if (event.type === 'metrics' && event.metrics) {
        const metrics = event.metrics;
        setStats(previous => previous ? { ...previous, latest: { ts: event.ts || Date.now(), ...metrics } } : previous);
      }
    });
    // Reconcile even when an event stream is temporarily unavailable.
    const timer = window.setInterval(() => { void load(); }, 10000);
    return () => { off(); window.clearInterval(timer); };
  }, [space, serviceId, load, refresh]);

  useEffect(() => {
    setConnection(''); setRevealed({}); setDeployment(null); setEnvValue(''); setError(''); setMessage('');
  }, [tab, writable]);

  useEffect(() => {
    if (!service) return;
    let cancelled = false;
    setLoading(true); setDataError('');
    const fetchTab = async () => {
      if (tab === 'Overview') {
        const results = await Promise.allSettled([api.serviceStats(space, null, serviceId), api.serviceUptime(space, null, serviceId, '24h')]);
        if (cancelled) return;
        setStats(results[0].status === 'fulfilled' ? results[0].value : null);
        setUptime(results[1].status === 'fulfilled' ? results[1].value : null);
      } else if (tab === 'Deployments' && writable) {
        const rows = await api.listDeployments(space, null, serviceId);
        if (!cancelled) setDeployments(rows);
      } else if (tab === 'Runtime logs' && writable) {
        const result = await api.serviceRuntimeLogs(space, null, serviceId);
        if (!cancelled) setLogs(result.logs);
      } else if (tab === 'Environment' && writable) {
        const rows = await api.listEnvVars(space, null, serviceId);
        if (!cancelled) setEnv(rows);
      }
    };
    void fetchTab().catch(e => { if (!cancelled) setDataError(e instanceof Error ? e.message : 'Unable to load this view.'); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [space, serviceId, tab, revision, writable, service?.status]);

  async function run(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(''); setMessage('');
    try { await action(); }
    catch (e) { if (alive.current) setError(e instanceof Error ? e.message : 'Request failed.'); }
    finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }

  async function connectionIntent(copy: boolean) {
    if (!service?.internal_hostname) throw new Error('The server has not assigned an internal hostname yet.');
    const values = await Promise.all(['POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB'].map(key => api.revealEnvVar(space, null, serviceId, key)));
    if (!alive.current) return;
    const uri = `postgresql://${encodeURIComponent(values[0].value)}:${encodeURIComponent(values[1].value)}@${service.internal_hostname}:${service.container_port}/${encodeURIComponent(values[2].value)}`;
    if (copy) {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable. Use Reveal connection to select and copy it manually.');
      await navigator.clipboard.writeText(uri);
      if (alive.current) setMessage('Connection URI copied, including the password. Share it only with trusted applications.');
    } else setConnection(uri);
  }

  if (!service) return <section aria-label="Selected service details" className="min-w-0 border-t border-border-subtle pt-5">
    {loadError ? <><p role="alert" className="text-xs text-feedback-error-text">{loadError}</p><button className={`${buttonClass} mt-3`} onClick={() => void load()}>Retry service</button></> : <p role="status" className="text-xs text-txt-secondary">Loading service...</p>}
  </section>;

  const row = (label: string, value: React.ReactNode) => <div className="flex flex-wrap justify-between gap-2 py-2.5 border-b border-border-subtle text-xs"><dt className="text-txt-secondary">{label}</dt><dd className="font-mono break-all text-right">{value}</dd></div>;
  const endpoint = service.internal_hostname ? `${service.internal_hostname}:${service.container_port}` : 'Not assigned yet';

  return <section aria-label="Selected service details" className="min-w-0 border-t xl:border-t-0 xl:border-l border-border-subtle pt-5 xl:pt-0 xl:pl-6 space-y-4">
    <header>
      <div className="flex items-center justify-between gap-3"><span className="text-txt-brand">{postgres ? <Database className="w-5 h-5" /> : <Box className="w-5 h-5" />}</span><span className="inline-flex items-center gap-1.5 text-xs text-txt-secondary">{deploying && <Loader2 className="w-3.5 h-3.5 animate-spin" />}{service.status}</span></div>
      <h3 ref={heading} tabIndex={-1} className="mt-3 text-xl font-semibold tracking-tight break-all focus:outline-none">{service.name}</h3>
      <p className="mt-1 text-xs text-txt-secondary break-all">{service.source_type === 'git' ? service.git_url : service.image_ref}</p>
    </header>
    {writable && <div className="flex flex-wrap gap-2">
      <button className={buttonClass} disabled={busy || deploying} onClick={() => void run(async () => { const next = await api.patchDeployService(space, null, serviceId, { desired_state: service.desired_state === 'stopped' ? 'running' : 'stopped' }); if (alive.current) { setService(next); setMessage('Runtime state change requested.'); refresh(); } })}>{service.desired_state === 'stopped' ? <Play className="w-3.5 h-3.5" /> : <Square className="w-3.5 h-3.5" />}{service.desired_state === 'stopped' ? 'Start' : 'Stop'}</button>
      <button className={`${buttonClass} bg-brand !text-white !border-brand hover:!bg-brand-hover`} disabled={busy || deploying} onClick={() => void run(async () => { await api.deployService(space, null, serviceId); if (alive.current) { setService(s => s ? { ...s, status: 'deploying' } : s); setMessage('Deployment requested. Follow its status in Deployments.'); refresh(); } })}>{service.source_type === 'git' ? 'Rebuild and deploy' : 'Deploy image'}</button>
      {deploying && <button className={buttonClass} disabled={busy} onClick={() => void run(async () => {
        await api.cancelDeploymentRun(space, null, serviceId);
        if (alive.current) { setMessage('Cancellation requested. Waiting for the deployment worker.'); refresh(); }
      })}>Cancel deployment</button>}
    </div>}
    {service.last_failed_deployment_id != null && <p className="text-xs text-feedback-error-text" role="alert">Deployment #{service.last_failed_deployment_id} failed. {service.status === 'running' && service.current_deployment_id ? `Release #${service.current_deployment_id} is still running.` : 'Inspect deployment history for the error.'}</p>}
    {loadError && <p className="text-xs text-feedback-error-text" role="alert">Refresh failed: {loadError}</p>}
    <nav aria-label="Service detail views" className="flex overflow-x-auto border-b border-border-subtle">
      {(writable ? ['Overview', 'Deployments', 'Runtime logs', 'Environment', 'Settings'] : ['Overview']).map(item => <button key={item} disabled={busy} aria-pressed={tab === item} className={`shrink-0 px-3 py-2.5 text-xs border-b-2 ${tab === item ? 'border-brand text-txt-brand' : 'border-transparent text-txt-secondary'}`} onClick={() => setTab(item)}>{item}</button>)}
    </nav>
    <div className="flex justify-end"><button className={buttonClass} disabled={busy || loading} onClick={refresh}><RefreshCw className="w-3 h-3" />Refresh</button></div>
    {busy && <p role="status" className="text-xs text-txt-secondary">Request in progress...</p>}
    {loading && <p role="status" className="text-xs text-txt-secondary">Loading {tab.toLowerCase()}...</p>}
    {error && <p role="alert" className="text-xs text-feedback-error-text whitespace-pre-wrap">{error}</p>}
    {dataError && <p role="alert" className="text-xs text-feedback-error-text">{dataError}</p>}
    {message && <p role="status" className="text-xs text-txt-secondary">{message}</p>}
    {tab === 'Overview' && <>
      <dl>
        {row('Access', service.exposure === 'internal' ? 'Internal network' : 'HTTP routing')}
        {row('Internal endpoint', endpoint)}
        {row('Source', service.source_type === 'git' ? 'External Git' : postgres ? 'PostgreSQL image' : 'Container image')}
        {service.source_type === 'git' && <>{row('Git reference', service.branch)}{row('Build context', service.root_dir)}{row('Dockerfile / target', `${service.dockerfile_path}${service.build_target ? ` / ${service.build_target}` : ''}`)}{row('Resolved commit', service.current?.short_sha || 'Available after build')}</>}
        {row('CPU limit', `${service.cpu_nano_cpus / 1e9} cores`)}
        {row('Memory limit', `${Math.round(service.memory_bytes / 1048576)} MB`)}
        {row('CPU usage (of limit)', stats?.latest ? `${stats.latest.cpuPctOfLimit.toFixed(1)}%` : 'No sample available')}
        {row('Memory used', stats?.latest ? `${Math.round(stats.latest.memUsedBytes / 1048576)} MB` : 'No sample available')}
        {row('Uptime (24h)', uptime?.uptime_pct != null ? `${uptime.uptime_pct.toFixed(1)}% (${uptime.checks_total} checks)` : 'No checks available')}
        {row('Health check', postgres ? 'docker (pg_isready)' : service.runtime_options?.health_type || 'http')}
        {service.deployment_strategy === 'recreate' && row('Release strategy', 'Stop then start')}
      </dl>
      {postgres && <div className="space-y-2">
        <label className="block text-xs text-txt-secondary">Connection URI<input readOnly autoComplete="off" spellCheck={false} className={`${inputClass} font-mono mt-2`} value={connection || `postgresql://USER:********@${endpoint}/DATABASE`} onFocus={e => e.target.select()} /></label>
        {writable && <div className="flex flex-wrap gap-2"><button disabled={busy} className={buttonClass} onClick={() => connection ? setConnection('') : void run(() => connectionIntent(false))}>{connection ? 'Hide connection' : 'Reveal connection'}</button><button disabled={busy} className={buttonClass} onClick={() => void run(() => connectionIntent(true))}><Copy className="w-3 h-3" />Copy connection URI</button></div>}
        <p className="text-[11px] text-txt-tertiary">The server generates and encrypts the password. Revealing or copying requests authorized secret access.</p>
      </div>}
      <p className="text-xs text-txt-secondary leading-relaxed border-l-2 border-brand pl-3">Internal networking is the shared approved apps network, not per-space isolation. {service.exposure === 'internal' ? 'No public TCP proxy or HTTP routing.' : 'Public HTTP may receive an automatic address under the instance base domain. Attached custom domains require ownership verification.'}</p>
      {writable && service.exposure === 'http' && <button className={buttonClass} onClick={() => setTab('Settings')}>Configure HTTP domains</button>}
      {service.domains?.length ? <div className="space-y-1"><h4 className="text-xs text-txt-secondary">Verified domains</h4>{service.domains.map(domain => <p key={domain} className="text-xs font-mono break-all">{domain}{service.tls_risk_domains?.includes(domain) ? ' (TLS coverage at risk)' : ''}</p>)}</div> : null}
      {service.unverified_domains?.length ? <p className="text-xs text-txt-secondary">{service.unverified_domains.length} domains awaiting ownership verification; not routed.</p> : null}
      {service.volume_path && <div className="space-y-2">
        <h4 className="text-sm font-medium">Managed storage</h4>
        <dl>{row('Volume name', service.volume_name || 'Assigned at deployment')}{row('Container mount', service.volume_path)}{row('On service deletion', 'Retain data')}</dl>
        <p className="text-xs text-txt-secondary">Uses host disk as data grows, not a preallocated quota. No backup configured. A retained volume is not a backup.</p>
      </div>}
      {!!service.runtime_options?.host_config.binds.length && <div className="space-y-2"><h4 className="text-sm font-medium">Host mounts</h4><pre className="text-xs font-mono whitespace-pre-wrap break-all border border-border-subtle bg-surface-base p-3">{service.runtime_options.host_config.binds.join('\n')}</pre><button className={buttonClass} disabled={busy} onClick={() => void run(async () => { await navigator.clipboard.writeText(service.runtime_options!.host_config.binds.join('\n')); setMessage('Mount configuration copied. Paths refer to the deployment host.'); })}><Copy className="w-3 h-3" />Copy mount configuration</button></div>}
      {service.runtime_options?.entrypoint && <div><h4 className="text-xs text-txt-secondary mb-2">Startup command</h4><pre className="text-xs whitespace-pre-wrap break-all font-mono">{JSON.stringify([...service.runtime_options.entrypoint, ...(service.runtime_options.command || [])])}</pre></div>}
    </>}
    {tab === 'Deployments' && writable && <div className="space-y-3">
      {postgres && <><p className="text-xs text-txt-secondary">Version upgrades and rollback are disabled here: reverting a container does not safely revert PostgreSQL data. Use an operator-managed migration and backup.</p><div className="flex gap-2"><button disabled className={buttonClass}>Upgrade version</button><button disabled className={buttonClass}>Rollback</button></div></>}
      {!loading && !deployments.length && <p className="text-xs text-txt-secondary">No deployments yet.</p>}
      <ul className="divide-y divide-border-subtle">{deployments.map(dep => <li key={dep.id} className="py-3 space-y-1"><button className="text-xs text-txt-brand hover:underline text-left" disabled={busy} onClick={() => void run(async () => { const result = await api.getDeployment(space, null, serviceId, dep.id); if (alive.current) setDeployment(result); })}>#{dep.id} / {dep.status} / {dep.short_sha || dep.ref || service.image_ref}</button><p className="text-[11px] text-txt-tertiary">{new Date(dep.started).toLocaleString()} / {dep.trigger}</p>{dep.error && <p className="text-xs text-feedback-error-text whitespace-pre-wrap">{dep.error}</p>}</li>)}</ul>
      {deployment && <div className="space-y-2">
        <h4 className="text-sm font-medium">Deployment #{deployment.id}</h4>
        <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-surface-base border border-border-subtle p-3 text-xs font-mono">{deployment.build_log || 'No build output recorded.'}</pre>
        {!service.template && !service.volume_path && <button className={buttonClass} disabled={busy || deploying || !deployment.image_tag || deployment.id === service.current_deployment_id} onClick={() => {
          if (window.confirm(`Roll back ${service.name} to the image from deployment #${deployment.id}?`)) void run(async () => {
            await api.rollbackDeployment(space, null, serviceId, deployment.id);
            if (alive.current) { setMessage('Rollback requested.'); refresh(); }
          });
        }}>Roll back to this image</button>}
        {service.volume_path && !postgres && <p className="text-xs text-txt-secondary">Rollback is disabled for services with persistent data. Restore data explicitly with the operator.</p>}
      </div>}
    </div>}
    {tab === 'Runtime logs' && writable && <div><p className="text-[11px] text-txt-tertiary mb-2">Container output snapshot. Refresh to fetch new output.</p><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all bg-surface-base border border-border-subtle p-3 text-xs font-mono">{logs || (!loading ? 'No runtime output available.' : '')}</pre></div>}
    {tab === 'Environment' && writable && <div className="space-y-4">
      <p className="text-xs text-txt-secondary">Values stay hidden until requested. Apply runtime from Settings after changing environment variables.</p>
      <ul className="divide-y divide-border-subtle">{env.map(item => {
        const visible = Object.prototype.hasOwnProperty.call(revealed, item.key);
        return <li key={item.key} className="py-3 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="text-xs break-all">{item.key}</code>
            <div className="flex gap-2">
              <button className={buttonClass} disabled={busy} onClick={() => visible ? setRevealed(values => {
                const next = { ...values }; delete next[item.key]; return next;
              }) : void run(async () => {
                const result = await api.revealEnvVar(space, null, serviceId, item.key);
                if (alive.current) setRevealed(values => ({ ...values, [item.key]: result.value }));
              })}>{visible ? 'Hide' : 'Reveal'}<span className="sr-only"> {item.key}</span></button>
              {!postgres && <button className={buttonClass} disabled={busy || deploying} onClick={() => {
                if (window.confirm(`Remove ${item.key}? Apply runtime afterwards.`)) void run(async () => {
                  await api.removeEnvVar(space, null, serviceId, item.key); setRevealed({}); refresh();
                });
              }}>Remove<span className="sr-only"> {item.key}</span></button>}
            </div>
          </div>
          {visible && <input aria-label={`${item.key} value`} className={`${inputClass} font-mono`} readOnly value={revealed[item.key]} />}
        </li>;
      })}</ul>
      {!postgres ? <form className="space-y-2 border-t border-border-subtle pt-4" onSubmit={e => {
        e.preventDefault();
        void run(async () => {
          if (!ENV_KEY_RE.test(envKey)) throw new Error('Enter a valid environment variable name.');
          await api.patchDeployService(space, null, serviceId, { env: { [envKey]: envValue } });
          setEnvValue(''); setEnvKey(''); setRevealed({});
          setMessage('Environment saved. Apply runtime to use the new values.'); refresh();
        });
      }}>
        <label className="block text-xs text-txt-secondary">Variable name<input required className={`${inputClass} mt-1`} value={envKey} onChange={e => setEnvKey(e.target.value)} /></label>
        <label className="block text-xs text-txt-secondary">Variable value<input type="password" autoComplete="new-password" className={`${inputClass} mt-1`} value={envValue} onChange={e => setEnvValue(e.target.value)} /></label>
        <button disabled={busy || deploying} className={buttonClass}>Save variable</button>
      </form> : <p className="text-xs text-txt-secondary">Database initialization variables are managed by the template. Editing them does not rotate an existing database password or migrate its data.</p>}
    </div>}
    {tab === 'Settings' && writable && <StandaloneSettings service={service} capabilities={capabilities} disabled={busy || deploying} onSave={patch => void run(async () => { const next = await api.patchDeployService(space, null, serviceId, patch); if (alive.current) { setService(next); setMessage('Settings saved. Rebuild for source changes, or apply runtime for runtime-only changes.'); onChanged(); } })} onApply={() => void run(async () => { if (!service.current_deployment_id) throw new Error('Deploy this service once before applying runtime.'); await api.redeployDeployment(space, null, serviceId, service.current_deployment_id); if (alive.current) { setService(s => s ? { ...s, status: 'deploying' } : s); setMessage('Runtime apply requested using the current image.'); refresh(); } })} onDelete={() => { if (window.confirm(`Delete ${service.name} and stop its container? Managed volumes remain on the host. This does not create a backup.`)) void run(async () => { await api.deleteDeployService(space, null, serviceId); if (alive.current) onDeleted(); }); }} />}
    {tab === 'Settings' && writable && service.exposure === 'http' && <StandaloneDomains space={space} serviceId={serviceId} disabled={busy || deploying} onChanged={onChanged} />}
  </section>;
}

function StandaloneDomains({ space, serviceId, disabled, onChanged }: { space: string; serviceId: number; disabled: boolean; onChanged: () => void }) {
  const [domains, setDomains] = useState<DomainEntry[]>([]);
  const [draft, setDraft] = useState('');
  const [kind, setKind] = useState<'caddy' | 'tunnel'>('tunnel');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [warning, setWarning] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    void api.listDomains(space, null, serviceId).then(rows => { if (!cancelled) setDomains(rows); })
      .catch(e => { if (!cancelled) setError(e.message || 'Unable to load domains.'); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [space, serviceId, revision]);
  async function act(action: () => Promise<void>) {
    if (busy || disabled) return;
    setBusy(true); setError('');
    try { await action(); setRevision(r => r + 1); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Domain request failed.'); }
    finally { setBusy(false); }
  }
  async function attach(confirm = false) {
    try {
      await api.addDomain(space, null, serviceId, draft.trim(), kind, confirm);
      setDraft(''); setWarning('');
    } catch (e) {
      const body = (e as { body?: { code?: string; message?: string } }).body;
      if (body?.code === 'TLS_DEPTH_CONFIRMATION') { setWarning(body.message || 'This hostname may not be covered by your TLS certificate.'); return; }
      throw e;
    }
  }
  return <section aria-label="HTTP domains" className="border-t border-border-subtle pt-5 space-y-3">
    <h4 className="text-sm font-medium">HTTP domains</h4>
    <p className="text-xs text-txt-secondary">Attaching a custom domain does not prove ownership. Routing for that domain stays disabled until verified. Public HTTP may also use an automatic base-domain address.</p>
    <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act(() => attach()); }}>
      <label className="block text-xs text-txt-secondary">Domain name<input required className={`${inputClass} mt-1`} value={draft} disabled={busy || disabled} placeholder="app.example.com" onChange={e => { setDraft(e.target.value); setWarning(''); }} /></label>
      <label className="block text-xs text-txt-secondary">Domain routing<select className={`${inputClass} mt-1`} value={kind} disabled={busy || disabled} onChange={e => { setKind(e.target.value as typeof kind); setWarning(''); }}><option value="tunnel">Cloudflare Tunnel</option><option value="caddy">Host Caddy / Nginx</option></select></label>
      <button className={buttonClass} disabled={busy || disabled || !draft.trim()}>Attach domain</button>
    </form>
    {warning && <div className="space-y-2 border-l-2 border-brand pl-3"><p role="alert" className="text-xs text-txt-secondary">TLS coverage warning: {warning}</p><button className={buttonClass} disabled={busy || disabled} onClick={() => void act(() => attach(true))}>Accept TLS risk and attach</button><button className={`${buttonClass} ml-2`} onClick={() => setWarning('')}>Cancel</button></div>}
    {busy && <p role="status" className="text-xs text-txt-secondary">Loading domain state...</p>}
    {error && <p role="alert" className="text-xs text-feedback-error-text">{error}</p>}
    <button className={buttonClass} disabled={busy || disabled} onClick={() => { setError(''); setRevision(r => r + 1); }}>Refresh domains</button>
    {!busy && !domains.length && <p className="text-xs text-txt-tertiary">No custom domains attached.</p>}
    <ul className="divide-y divide-border-subtle">{domains.map(domain => <li key={domain.id} className="py-3 space-y-2 text-xs">
      <p className="font-mono break-all">{domain.domain}</p>
      <p className="text-txt-secondary">{domain.verified ? 'Ownership verified' : 'Awaiting verification; not routed'}{domain.tls_risk ? ' / TLS coverage at risk' : ''}</p>
      {domain.verification?.record && <pre className="whitespace-pre-wrap break-all font-mono border border-border-subtle p-2">TXT {domain.verification.record.name}{'\n'}{domain.verification.record.value}</pre>}
      {domain.guidance?.dns.map((record, index) => <p key={index} className="break-all font-mono text-[11px]">{record.type} {record.name} / {record.target}</p>)}
      {domain.guidance?.notes.map(note => <p key={note} className="text-txt-secondary">{note}</p>)}
      {domain.dns?.error && <p className="text-feedback-error-text">DNS: {domain.dns.error}</p>}
      <div className="flex flex-wrap gap-2">
        {!domain.verified && <button className={buttonClass} disabled={busy || disabled} onClick={() => void act(async () => { const result = await api.verifyDomain(space, null, serviceId, domain.id); if (!result.verified) throw new Error(result.message || 'Ownership was not verified. Check the TXT record.'); })}>Verify ownership</button>}
        {domain.dns?.status === 'failed' && <button className={buttonClass} disabled={busy || disabled} onClick={() => void act(async () => { await api.retryDomainDns(space, null, serviceId, domain.id); })}>Retry DNS</button>}
        <button className={buttonClass} disabled={busy || disabled} onClick={() => {
          if (window.confirm(`Detach ${domain.domain}? HTTP access through this hostname will stop.`)) void act(async () => {
            const result = await api.removeDomain(space, null, serviceId, domain.id);
            if (result.dns?.error && !result.dns.removed) setError(`Domain detached, but DNS cleanup failed: ${result.dns.error}`);
          });
        }}>Detach domain</button>
      </div>
    </li>)}</ul>
  </section>;
}

type ServicePatch = Parameters<typeof api.patchDeployService>[3];

function StandaloneSettings({ service, capabilities, disabled, onSave, onApply, onDelete }: {
  service: DeployService;
  capabilities?: DeploymentCapabilities;
  disabled: boolean;
  onSave: (patch: ServicePatch) => void;
  onApply: () => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(service.name);
  const [source, setSource] = useState(service.git_url || service.image_ref || '');
  const [branch, setBranch] = useState(service.branch);
  const [root, setRoot] = useState(service.root_dir);
  const [dockerfile, setDockerfile] = useState(service.dockerfile_path);
  const [target, setTarget] = useState(service.build_target || '');
  const [cpu, setCpu] = useState(service.cpu_nano_cpus / 1e9);
  const [memory, setMemory] = useState(Math.round(service.memory_bytes / 1048576));
  const [port, setPort] = useState(service.container_port);
  const [exposure, setExposure] = useState(service.exposure || 'internal');
  const hostOptions = service.runtime_options?.host_config;
  const admin = Boolean(capabilities?.gpus || capabilities?.host_mounts);
  const operatorRuntime = !admin && Object.values(hostOptions || {}).some(value => {
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return Boolean(value);
  });
  const editableRuntime = { ...service.runtime_options };
  // The API gates even explicit empty host_config fields. Ordinary writers edit
  // only application options; an existing privileged runtime stays operator-owned.
  if (!admin && !operatorRuntime) delete editableRuntime.host_config;
  const runtimeBaseline = JSON.stringify(editableRuntime, null, 2);
  const [runtime, setRuntime] = useState(runtimeBaseline);
  const [error, setError] = useState('');
  const postgres = service.template === 'postgres';
  const field = (label: string, value: string, change: (v: string) => void, required = true) => <label className="block text-xs text-txt-secondary">{label}<input className={`${inputClass} mt-1`} required={required} value={value} onChange={e => change(e.target.value)} /></label>;

  return <div className="space-y-5">
    <form className="space-y-3" onSubmit={e => {
      e.preventDefault(); setError('');
      try {
        const patch: ServicePatch = { name, cpu_nano_cpus: Math.round(cpu * 1e9), memory_bytes: Math.round(memory * 1048576) };
        if (!postgres) {
          const parsed: unknown = JSON.parse(runtime);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Runtime options must be a JSON object.');
          Object.assign(patch, { container_port: port, exposure });
          // Do not resubmit unchanged privileged settings on ordinary member edits.
          if (!operatorRuntime && runtime !== runtimeBaseline) {
            if (!admin && Object.prototype.hasOwnProperty.call(parsed, 'host_config')) throw new Error('Host configuration requires instance-admin permission.');
            patch.runtime_options = parsed as Record<string, unknown>;
          }
          if (service.source_type === 'git') Object.assign(patch, { git_url: source, branch, root_dir: root, dockerfile_path: dockerfile, build_target: target || null });
          else patch.image_ref = source;
        }
        onSave(patch);
      } catch (e) { setError(e instanceof Error ? e.message : 'Invalid settings.'); }
    }}>
      <fieldset disabled={disabled} className="space-y-3">
        {field('Service name', name, setName)}
        {!postgres && <>
          {field(service.source_type === 'git' ? 'Git URL' : 'Image reference', source, setSource)}
          {service.source_type === 'git' && <>{field('Branch / full PR ref', branch, setBranch)}{field('Build context', root, setRoot)}{field('Dockerfile path', dockerfile, setDockerfile)}{field('Build target', target, setTarget, false)}</>}
          <label className="block text-xs text-txt-secondary">Container port<input className={`${inputClass} mt-1`} type="number" required min={1} max={65535} value={port} onChange={e => setPort(Number(e.target.value))} /></label>
          <label className="block text-xs text-txt-secondary">Network access<select className={`${inputClass} mt-1`} value={exposure} onChange={e => setExposure(e.target.value as typeof exposure)}><option value="internal">Internal</option><option value="http">HTTP routing</option></select></label>
          <label className="block text-xs text-txt-secondary">Runtime options (JSON)<textarea className={`${inputClass} mt-1 font-mono`} rows={12} disabled={operatorRuntime} value={runtime} onChange={e => setRuntime(e.target.value)} spellCheck={false} /></label>
          {operatorRuntime && <p className="text-xs text-txt-secondary">This runtime has operator-managed host settings. Ask an instance admin to edit runtime options; source and resource limits remain editable.</p>}
          <p className="text-[11px] text-txt-tertiary">Command / entrypoint arrays and HTTP, TCP or Docker health checks. Host mounts and GPU requests require instance-admin policy. Approved bind prefixes: {capabilities?.bind_allowlist.join(', ') || 'none'}. GPU access: {capabilities?.gpus ? 'permitted; NVIDIA Container Toolkit required, hardware not detected' : 'not permitted'}.</p>
        </>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-xs text-txt-secondary">CPU cores<input className={`${inputClass} mt-1`} type="number" required min={0.1} step={0.1} max={64} value={cpu} onChange={e => setCpu(Number(e.target.value))} /></label>
          <label className="block text-xs text-txt-secondary">Memory MB<input className={`${inputClass} mt-1`} type="number" required min={32} max={262144} value={memory} onChange={e => setMemory(Number(e.target.value))} /></label>
        </div>
        {error && <p role="alert" className="text-xs text-feedback-error-text">{error}</p>}
        <button className={buttonClass}>Save settings</button>
      </fieldset>
    </form>
    {postgres && <p className="text-xs text-txt-secondary">PostgreSQL image version, initialization variables, internal port and retained storage are locked. Version changes and rollback require an operator-managed data migration.</p>}
    <div className="border-t border-border-subtle pt-4 space-y-2"><button disabled={disabled || !service.current_deployment_id} className={buttonClass} onClick={onApply}>Apply runtime</button><p className="text-[11px] text-txt-tertiary">Uses the current deployment image, not a source rebuild. Stop/start services briefly go offline. Save settings first.</p></div>
    <div className="border-t border-border-subtle pt-4 space-y-2"><button className={`${buttonClass} !text-feedback-error-text`} disabled={disabled} onClick={onDelete}>Delete service</button><p className="text-[11px] text-txt-tertiary">Stops the container. Managed volumes remain; no backup is created.</p></div>
  </div>;
}

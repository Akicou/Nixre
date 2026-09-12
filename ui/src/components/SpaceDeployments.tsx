import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, AlertTriangle, Box, Check, Cpu, Database, GitBranch, Loader2, Plus, Search, X } from 'lucide-react';
import { api, DeployService, SpaceDeploymentsBoard } from '../lib/api';
import { subscribeDeployEvents } from '../lib/deployEvents';
import { GuidedServiceModal, ServicePreset } from './GuidedServiceModal';
import { StandaloneServiceDetail } from './StandaloneServiceDetail';

function timeAgo(ts: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function triggerLabel(trigger: string): string {
  return ({ push: 'via git push', manual: 'via manual deploy', boot: 'via boot reconcile', rollback: 'via rollback', redeploy: 'via redeploy' } as Record<string, string>)[trigger] || `via ${trigger}`;
}

function statusLine(service: DeployService): string {
  if (['deploying', 'queued', 'building', 'releasing'].includes(service.status)) return 'Deployment in progress';
  if (service.desired_state === 'stopped' || service.status === 'stopped') return 'Stopped';
  if (service.alert) return service.current?.status === 'live' ? 'last release failed; previous release running' : 'last release failed';
  if (service.status === 'failed') return 'Service failed; inspect deployment history';
  if (service.current) return `Deployed ${timeAgo(service.current.finished || service.current.started)} ${triggerLabel(service.current.trigger)}`;
  return 'Not deployed yet';
}

function serviceSource(service: DeployService): string {
  if (service.source_type === 'git') return `External Git / ${service.git_url || ''}`;
  if (service.source_type === 'image') return `Container image / ${service.image_ref || ''}`;
  return `Nixre Git / ${service.repo_uid || ''} / ${service.branch}`;
}

export function SpaceDeployments({ spaceUid }: { spaceUid: string }) {
  const [board, setBoard] = useState<SpaceDeploymentsBoard | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [preset, setPreset] = useState<ServicePreset | null>(null);
  const [params, setParams] = useSearchParams();
  const request = useRef(0);
  const selectedId = /^\d+$/.test(params.get('service') || '') ? Number(params.get('service')) : null;
  const load = useCallback(() => {
    const id = ++request.current;
    void api.spaceDeployments(spaceUid).then(next => {
      if (request.current === id) { setBoard(next); setError(''); }
    }).catch(e => { if (request.current === id) setError(e.message || 'Failed to load deployments.'); });
  }, [spaceUid]);

  useEffect(() => { setBoard(null); load(); return () => { request.current++; }; }, [load]);
  // Subscribe by identity, not the board object: status refreshes must not reopen every stream.
  const subscriptions = JSON.stringify((board?.services || []).filter(s => s.id !== selectedId).map(s => [s.id, !s.source_type || s.source_type === 'repo' ? s.repo_uid : null]));
  useEffect(() => {
    const entries = JSON.parse(subscriptions) as Array<[number, string | null]>;
    const offs = entries.map(([id, repo]) => subscribeDeployEvents(spaceUid, repo ?? null, id, event => { if (event.type === 'status') load(); }));
    return () => offs.forEach(off => off());
  }, [spaceUid, subscriptions, load]);

  function select(id: number | null) {
    setParams(previous => { const next = new URLSearchParams(previous); next.set('tab', 'deployments'); if (id === null) next.delete('service'); else next.set('service', String(id)); return next; });
  }

  if (!board) return <div className="py-12 text-center text-sm text-txt-secondary">{error ? <><p role="alert" className="text-feedback-error-text">{error}</p><button onClick={load} className="mt-3 text-txt-brand hover:underline">Retry deployments</button></> : <p role="status"><Loader2 className="w-4 h-4 inline-block mr-2 animate-spin" />Loading deployments...</p>}</div>;

  const visible = board.services.filter(s => `${s.name} ${serviceSource(s)}`.toLowerCase().includes(query.toLowerCase().trim()));
  const selected = board.services.find(s => s.id === selectedId);
  const legacySelected = selected && (!selected.source_type || selected.source_type === 'repo');
  const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-md border border-border-subtle px-3 py-2 text-xs font-medium text-txt-primary hover:bg-surface-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand';

  return <div className="space-y-6 text-txt-primary" data-testid="space-deployments-board">
    <header className="flex items-start justify-between gap-3">
      <div><p className="text-[10px] uppercase tracking-widest font-mono text-txt-tertiary mb-2">{spaceUid} / Deployments</p><h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">A home for everything you run.</h2><p className="text-xs text-txt-secondary mt-2">Repositories, models and databases. One service at a time.</p></div>
      {board.can_write && <button className={`${buttonClass} shrink-0 !bg-brand !text-white !border-brand hover:!bg-brand-hover`} onClick={() => setPreset('git')}><Plus className="w-4 h-4" />New service</button>}
    </header>
    {error && <p role="alert" className="text-xs text-feedback-error-text">Refresh failed: {error} <button onClick={load} className="underline">Retry</button></p>}
    <div className="border-y border-border-subtle py-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-txt-secondary" aria-label="Service summary">
      <span><strong className="text-txt-primary font-mono">{board.services.length}</strong> services</span>
      <span><strong className="text-txt-primary font-mono">{board.services.filter(s => s.status === 'running' && s.desired_state !== 'stopped').length}</strong> running</span>
      <span><strong className="text-txt-primary font-mono">{board.services.filter(s => s.exposure === 'internal').length}</strong> internal</span>
      <span className="ml-auto">Shared apps network, not per-space isolation</span>
    </div>
    <div className={`grid grid-cols-1 gap-6 ${selectedId ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]' : ''}`}>
      <div className="min-w-0 space-y-6">
        <section aria-label="Services">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3"><h3 className="text-sm font-semibold">Services <span className="font-mono text-txt-tertiary ml-1">{visible.length}</span></h3><label className="flex items-center gap-2 min-w-0"><Search className="w-3.5 h-3.5 text-txt-tertiary" /><span className="sr-only">Search services</span><input type="search" className="w-40 sm:w-48 min-w-0 bg-transparent text-xs py-2 border-b border-border-subtle focus:outline-none focus:border-brand" placeholder="Find a service..." value={query} onChange={e => setQuery(e.target.value)} /></label></div>
          <div className="grid grid-cols-[minmax(0,1fr)_80px_80px] gap-3 border-b border-border-subtle pb-2 px-2 text-[10px] text-txt-tertiary uppercase tracking-wider" aria-hidden="true"><span>Service / source</span><span>Status</span><span>Access</span></div>
          <ul className="divide-y divide-border-subtle">
            {visible.map(service => {
              const repo = !service.source_type || service.source_type === 'repo';
              const href = repo ? `/${spaceUid}/${service.repo_uid}?deploys=1&svc=${service.id}` : `/${encodeURIComponent(spaceUid)}?tab=deployments&service=${service.id}`;
              const pending = ['deploying', 'queued', 'building', 'releasing'].includes(service.status);
              const Icon = service.template === 'postgres' ? Database : service.source_type === 'git' || repo ? GitBranch : Box;
              return <li key={service.id}><Link to={href} data-testid={`board-card-${service.name}`} aria-current={selectedId === service.id ? 'true' : undefined} className={`grid grid-cols-[minmax(0,1fr)_80px_80px] gap-3 py-4 px-2 rounded-sm hover:bg-surface-subtle/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${selectedId === service.id ? 'bg-brand/5' : ''}`}>
                <span className="min-w-0"><span className="flex items-center gap-2"><Icon className="w-4 h-4 shrink-0 text-txt-tertiary" /><span className="text-sm font-medium truncate">{service.name}</span></span><span className="block mt-1 text-[10px] font-mono text-txt-tertiary truncate" title={serviceSource(service)}>{serviceSource(service)}</span><span className={`block mt-2 text-[11px] ${service.alert || service.status === 'failed' ? 'text-feedback-error-text' : 'text-txt-secondary'}`}>{statusLine(service)}</span>
                  {service.domains?.map(domain => <span key={domain} className="block mt-1 text-[10px] font-mono text-txt-brand truncate">{service.tls_risk_domains?.includes(domain) && <AlertTriangle className="w-3 h-3 inline mr-1" />}{domain}</span>)}
                  {!!service.unverified_domains?.length && <span data-testid="space-unverified-domains" className="block mt-1 text-[10px] text-txt-secondary">{service.unverified_domains.length} domains awaiting verification</span>}
                </span>
                <span className="text-[11px] flex items-start gap-1 pt-1 text-txt-secondary">{pending && <Loader2 className="w-3 h-3 mt-0.5 animate-spin shrink-0" />}{service.status}</span>
                <span className="text-[11px] pt-1 text-txt-secondary">{service.exposure === 'internal' ? 'Internal' : 'HTTP'}</span>
              </Link></li>;
            })}
          </ul>
          {!board.services.length && <p className="py-10 text-center text-sm text-txt-secondary">No deployment services in this space yet.</p>}
          {!!board.services.length && !visible.length && <p className="py-8 text-center text-xs text-txt-secondary">No matching services. Try a different name or source.</p>}
        </section>
        {board.can_write && <section className="border-t border-border-subtle pt-5 space-y-2"><h3 className="text-sm font-medium">Something new, without the guesswork.</h3><p className="text-xs text-txt-secondary">Pick a starting point. We will walk through the rest.</p><div className="flex flex-wrap gap-2 pt-1"><button className={buttonClass} onClick={() => setPreset('llama')}><Cpu className="w-4 h-4" />Try llama.cpp</button><button className={buttonClass} onClick={() => setPreset('postgres')}><Database className="w-4 h-4" />Try PostgreSQL</button></div></section>}
        {!board.can_write && <p className="text-xs text-txt-tertiary">Read-only deployment access. Service creation requires space write permission.</p>}
        <section data-testid="board-activity" className="border-t border-border-subtle pt-5"><h3 className="flex items-center gap-2 text-sm font-semibold mb-3"><Activity className="w-4 h-4 text-txt-tertiary" />Recent activity</h3><ul className="divide-y divide-border-subtle">{board.activity.map(a => <li key={a.id} className="py-3"><div className="flex flex-wrap justify-between gap-2"><span className="text-xs font-medium">{a.service_name}</span><span className="text-[10px] text-txt-tertiary">{timeAgo(a.started)} / {triggerLabel(a.trigger)}</span></div><p className="flex items-center gap-1.5 text-xs text-txt-secondary mt-1">{a.status === 'failed' ? <X className="w-3 h-3 text-feedback-error-text" /> : a.status === 'live' ? <Check className="w-3 h-3" /> : <Activity className="w-3 h-3" />}<span>{({ live: 'Deployed', failed: 'Deploy failed', building: 'Building', releasing: 'Releasing', queued: 'Queued', cancelled: 'Cancelled' } as Record<string, string>)[a.status] || a.status}{a.ref ? ` · ${a.ref}` : ''}</span></p></li>)}</ul>{!board.activity.length && <p className="text-xs text-txt-tertiary">No deployments yet.</p>}</section>
      </div>
      {selectedId && (legacySelected ? <aside className="border-t xl:border-l xl:border-t-0 border-border-subtle pt-5 xl:pl-6"><h3 className="text-sm font-medium">{selected.name}</h3><p className="text-xs text-txt-secondary mt-2">This service belongs to a Nixre repository.</p><Link className={`${buttonClass} mt-3`} to={`/${spaceUid}/${selected.repo_uid}?deploys=1&svc=${selected.id}`}>Open repository deployments</Link></aside> : <StandaloneServiceDetail key={`${spaceUid}/${selectedId}`} space={spaceUid} serviceId={selectedId} canWrite={Boolean(board.can_write)} capabilities={board.capabilities} onChanged={load} onDeleted={() => { select(null); load(); }} />)}
    </div>
    {preset && board.can_write && <GuidedServiceModal space={spaceUid} capabilities={board.capabilities} initialPreset={preset} onClose={() => setPreset(null)} onComplete={service => { setPreset(null); setQuery(''); select(service.id); load(); }} />}
  </div>;
}

// Dashboard section — most active deployments across visible spaces with
// fleet uptime lanes. Charts are hand-built (no charting dependency), in the
// spirit of ContributionGraph.
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, Rocket, RefreshCw } from 'lucide-react';
import { api, DeployService, UptimeResponse } from '../lib/api';

const TOP = 6;

export const DeploymentsOverview: React.FC = () => {
  const [services, setServices] = useState<DeployService[] | null>(null);
  const [strips, setStrips] = useState<Record<number, UptimeResponse | undefined>>({});
  const [error, setError] = useState(false);

  const load = () => {
    // The section self-hides when the API layer lacks it (older mocks, or a
    // backend predating deployments) — never allowed to break the dashboard.
    try {
      void Promise.resolve(api.deploymentsOverview())
        .then(async svcs => {
          setServices(svcs);
          const top = svcs.slice(0, TOP);
          const results = await Promise.allSettled(
            top.map(s =>
              s.space && s.repo_uid
                ? api.serviceUptime(s.space, s.repo_uid, s.id, '24h')
                : Promise.reject(new Error('no repo ref')),
            ),
          );
          const map: Record<number, UptimeResponse | undefined> = {};
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') map[top[i].id] = r.value;
          });
          setStrips(map);
        })
        .catch(() => setError(true));
    } catch {
      setError(true);
    }
  };

  useEffect(load, []);

  if (error || !services?.length) return null;

  const serving = services.filter(s => s.live).length;
  const alerted = services.filter(s => s.alert).length;
  const totalReq = services.reduce((acc, s) => acc + (s.requests_24h || 0), 0);

  return (
    <section className="mb-8 border border-border-subtle rounded-lg overflow-hidden" data-testid="deployments-overview">
      <div className="flex items-center justify-between px-4 py-3 bg-surface-subtle/40 border-b border-border-subtle">
        <h2 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
          <Rocket className="w-4 h-4 text-brand" /> Most active deployments
          <span className="text-[10px] font-mono uppercase tracking-wider text-txt-tertiary">
            · last 24h
          </span>
        </h2>
        <div className="flex items-center gap-3 text-xs text-txt-secondary font-mono">
          <span data-testid="fleet-serving">{serving}/{services.length} live</span>
          {totalReq > 0 && <span>{totalReq.toLocaleString()} req</span>}
          {alerted > 0 && (
            <span className="text-red-400 flex items-center gap-1" data-testid="fleet-alerts">
              <AlertTriangle className="w-3 h-3" /> {alerted} failed deploy{alerted > 1 ? 's' : ''}
            </span>
          )}
          <button onClick={load} className="text-txt-tertiary hover:text-txt-primary" title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="divide-y divide-border-subtle">
        {services.slice(0, TOP).map(svc => {
          const strip = strips[svc.id];
          return (
            <Link
              key={svc.id}
              to={svc.space && svc.repo_uid ? `/${svc.space}/${svc.repo_uid}?deploys=1` : '#'}
              className="flex items-center gap-4 px-4 py-2.5 hover:bg-surface-subtle/50 transition"
            >
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  svc.alert ? 'bg-red-500 ring-2 ring-red-500/30' : svc.live ? 'bg-emerald-500' : 'bg-zinc-500'
                }`}
                title={svc.alert ? 'last deploy failed' : svc.live ? 'serving traffic' : 'not serving'}
              />
              <span className="font-mono text-xs text-txt-primary w-32 truncate">{svc.name}</span>
              <Link
                to={`/${svc.space}/${svc.repo_uid}`}
                onClick={e => e.stopPropagation()}
                className="font-mono text-[11px] text-txt-brand hover:underline w-48 truncate shrink-0"
              >
                {svc.space}/{svc.repo_uid}
              </Link>
              <span className="flex items-center gap-1.5 text-[11px] text-txt-secondary w-24 shrink-0">
                <Activity className="w-3 h-3" />
                {(svc.requests_24h || 0).toLocaleString('en-US')} req
              </span>
              <MiniStrip buckets={(strip?.buckets || []).slice(-72)} pct={strip?.uptime_pct ?? null} />
              <span className="font-mono text-[11px] text-txt-tertiary ml-auto shrink-0 hidden sm:inline">
                {svc.current?.short_sha || '—'}
              </span>
            </Link>
          );
        })}
      </div>
    </section>
  );
};

const MiniStrip: React.FC<{ buckets: { state: string }[]; pct: number | null }> = ({ buckets, pct }) => (
  <div className="flex-1 min-w-0 flex items-center gap-3">
    <div className="flex gap-[1px] items-stretch h-3.5 flex-1">
      {(buckets.length ? buckets : Array.from({ length: 48 }, () => ({ state: 'empty' }))).map((b, i) => (
        <div
          key={i}
          className={`flex-1 rounded-[1px] min-w-[2px] ${
            b.state === 'up' ? 'bg-emerald-500/70' : b.state === 'down' ? 'bg-red-500' : 'bg-surface-subtle'
          }`}
        />
      ))}
    </div>
    <span className="font-mono text-[10px] text-txt-tertiary w-10 text-right">
      {pct != null ? `${pct.toFixed(0)}%` : '—'}
    </span>
  </div>
);

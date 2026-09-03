// SpaceDeployments — Railway-style organization deployments board: one card
// per service (status icon, last deploy "X ago via <trigger>", domains) laid
// out on a dotted canvas, plus a live Activity feed of recent deployments
// across the space.

import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  Check,
  CircleDot,
  Loader2,
  Rocket,
  Square,
  X,
} from 'lucide-react';
import { api, DeployActivityEntry, DeployService } from '../lib/api';
import { subscribeDeployEvents } from '../lib/deployEvents';

function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function triggerLabel(trigger: string): string {
  switch (trigger) {
    case 'push': return 'via git push';
    case 'manual': return 'via manual deploy';
    case 'boot': return 'via boot reconcile';
    case 'rollback': return 'via rollback';
    case 'redeploy': return 'via redeploy';
    default: return `via ${trigger}`;
  }
}

const StatusIcon: React.FC<{ svc: DeployService }> = ({ svc }) => {
  if (svc.alert) return <X className="w-4 h-4 text-red-400 shrink-0" />;
  if (['queued', 'building', 'releasing'].includes(svc.status))
    return <Loader2 className="w-4 h-4 text-amber-400 animate-spin shrink-0" />;
  if (svc.status === 'running' && svc.current?.status === 'live')
    return <Check className="w-4 h-4 text-green-500 shrink-0" />;
  if (svc.status === 'stopped')
    return <Square className="w-3.5 h-3.5 text-txt-tertiary shrink-0" />;
  return <CircleDot className="w-4 h-4 text-txt-tertiary shrink-0" />;
};

const statusLine = (svc: DeployService): { text: string; cls: string } => {
  if (svc.alert) return { text: 'last release failed — serving previous', cls: 'text-red-400' };
  if (['queued', 'building', 'releasing'].includes(svc.status))
    return { text: `Deploying ${svc.current?.ref ? `(${svc.current.ref})` : ''}`.trim(), cls: 'text-amber-400' };
  if (svc.current) {
    return {
      text: `Deployed ${timeAgo(svc.current.finished || svc.current.started)} ${triggerLabel(svc.current.trigger)}`,
      cls: 'text-green-500',
    };
  }
  if (svc.status === 'stopped') return { text: 'Stopped', cls: 'text-txt-tertiary' };
  return { text: 'Not deployed yet', cls: 'text-txt-tertiary' };
};

const activityIcon = (status: string): React.ReactNode => {
  if (status === 'live') return <Check className="w-3.5 h-3.5 text-green-500" />;
  if (status === 'failed') return <X className="w-3.5 h-3.5 text-red-400" />;
  if (['queued', 'building', 'releasing'].includes(status))
    return <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />;
  return <CircleDot className="w-3.5 h-3.5 text-txt-tertiary" />;
};

const activityVerb = (status: string): string => {
  switch (status) {
    case 'live': return 'Deployed';
    case 'failed': return 'Deploy failed';
    case 'building': return 'Building';
    case 'releasing': return 'Releasing';
    case 'queued': return 'Queued';
    case 'cancelled': return 'Cancelled';
    default: return status;
  }
};

export const SpaceDeployments: React.FC<{ spaceUid: string }> = ({ spaceUid }) => {
  const [board, setBoard] = useState<{ services: DeployService[]; activity: DeployActivityEntry[] } | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    api
      .spaceDeployments(spaceUid)
      .then(setBoard)
      .catch(e => setError(e.message || 'Failed to load deployments.'));
  }, [spaceUid]);
  useEffect(load, [load]);

  // Live refresh while the board is visible.
  useEffect(() => {
    if (!board) return;
    const offs = board.services.map(svc =>
      subscribeDeployEvents(spaceUid, svc.repo_uid!, svc.id, () => load()),
    );
    return () => offs.forEach(off => off());
  }, [spaceUid, board, load]);

  if (error) return <p className="text-sm text-feedback-error-text">{error}</p>;
  if (!board)
    return (
      <div className="py-14 text-center text-txt-tertiary">
        <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" /> Loading deployments…
      </div>
    );

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-6" data-testid="space-deployments-board">
      {/* Canvas: service cards */}
      <div className="rounded-xl border border-border-subtle bg-surface-canvas p-5 min-h-[320px]">
        {board.services.length === 0 ? (
          <div className="h-full min-h-[240px] flex flex-col items-center justify-center gap-2 text-center">
            <Rocket className="w-6 h-6 text-txt-tertiary" />
            <p className="text-sm text-txt-secondary">No deployment services in this space yet.</p>
            <p className="text-xs text-txt-tertiary">Open a repository and enable the Deployments panel to ship Docker apps.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {board.services.map(svc => {
              const line = statusLine(svc);
              const href = `/${spaceUid}/${svc.repo_uid}?deploys=1&svc=${svc.id}`;
              return (
                <Link
                  key={svc.id}
                  to={href}
                  data-testid={`board-card-${svc.name}`}
                  className={`border rounded-lg p-4 space-y-2.5 transition block ${
                    svc.alert
                      ? 'border-red-400/50 bg-red-400/[0.03] hover:bg-red-400/[0.06]'
                      : 'border-border-subtle bg-surface-canvas hover:bg-surface-subtle/40'
                  }`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <StatusPillDot svc={svc} />
                    <span className="font-semibold text-sm text-txt-primary truncate">{svc.name}</span>
                    <span className="ml-auto text-[10px] font-mono uppercase text-txt-tertiary border border-border-subtle rounded px-1.5 py-0.5 shrink-0">
                      {svc.status}
                    </span>
                  </div>
                  {svc.domains?.length ? (
                    <p className="text-[11px] font-mono text-txt-brand truncate">{svc.domains[0]}</p>
                  ) : (
                    <p className="text-[11px] font-mono text-txt-tertiary truncate">
                      {svc.repo_uid} · {svc.branch}
                    </p>
                  )}
                  <p className={`text-xs flex items-center gap-1.5 ${line.cls}`}>
                    <StatusIcon svc={svc} />
                    {line.text}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Activity feed */}
      <aside className="border border-border-subtle rounded-xl bg-surface-canvas overflow-hidden self-start" data-testid="board-activity">
        <div className="px-4 py-3 border-b border-border-subtle flex items-center gap-2">
          <Activity className="w-4 h-4 text-brand" />
          <span className="text-sm font-semibold text-txt-primary">Activity</span>
        </div>
        <ul className="divide-y divide-border-subtle max-h-[560px] overflow-y-auto">
          {board.activity.length === 0 && (
            <li className="px-4 py-6 text-xs text-txt-tertiary text-center">No deployments yet.</li>
          )}
          {board.activity.map(a => (
            <li key={a.id} className="px-4 py-3">
              <p className="text-xs font-medium text-txt-primary truncate">{a.service_name}</p>
              <p className="text-xs text-txt-secondary flex items-center gap-1.5 mt-0.5">
                {activityIcon(a.status)}
                <span>{activityVerb(a.status)}{a.ref ? ` · ${a.ref}` : ''}</span>
              </p>
              <p className="text-[11px] text-txt-tertiary mt-0.5">{timeAgo(a.started)} · {triggerLabel(a.trigger)}</p>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
};

const StatusPillDot: React.FC<{ svc: DeployService }> = ({ svc }) => (
  <span
    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
      svc.alert
        ? 'bg-red-400'
        : svc.current?.status === 'live'
        ? 'bg-green-500'
        : ['queued', 'building', 'releasing'].includes(svc.status)
        ? 'bg-amber-400 animate-pulse'
        : 'bg-txt-tertiary/50'
    }`}
  />
);

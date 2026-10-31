// Dashboard timeline: every recent event the viewer can see, grouped by day,
// plus the "most active this week" leaderboard.
import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  GitCommitHorizontal,
  GitPullRequest,
  GitMerge,
  GitPullRequestClosed,
  Star,
  Rocket,
  CircleX,
  CircleCheck,
  FolderPlus,
  UserPlus,
  Sparkles,
  RefreshCw,
  Flame,
  Activity as ActivityIcon,
} from 'lucide-react';
import { ActivityContributor, ActivityEvent, ActivityKind } from '../lib/api';
import { Avatar } from './Avatar';

type Filter = 'all' | 'code' | 'prs' | 'ship' | 'community';

const FILTERS: { key: Filter; label: string; kinds: ActivityKind[] | null }[] = [
  { key: 'all', label: 'Everything', kinds: null },
  { key: 'code', label: 'Code', kinds: ['push'] },
  { key: 'prs', label: 'Pull requests', kinds: ['pr_opened', 'pr_merged', 'pr_closed'] },
  { key: 'ship', label: 'Deploys & CI', kinds: ['deploy_live', 'deploy_failed', 'run_success', 'run_failure'] },
  { key: 'community', label: 'Community', kinds: ['star', 'repo_created', 'user_joined'] },
];

const KIND_STYLE: Record<ActivityKind, { icon: React.ElementType; color: string }> = {
  push: { icon: GitCommitHorizontal, color: 'var(--color-activity-code)' },
  pr_opened: { icon: GitPullRequest, color: 'var(--color-activity-pr)' },
  pr_merged: { icon: GitMerge, color: 'var(--color-activity-merged)' },
  pr_closed: { icon: GitPullRequestClosed, color: 'var(--color-activity-fail)' },
  star: { icon: Star, color: 'var(--color-activity-star)' },
  deploy_live: { icon: Rocket, color: 'var(--color-activity-ship)' },
  deploy_failed: { icon: Rocket, color: 'var(--color-activity-fail)' },
  run_success: { icon: CircleCheck, color: 'var(--color-activity-pr)' },
  run_failure: { icon: CircleX, color: 'var(--color-activity-fail)' },
  repo_created: { icon: FolderPlus, color: 'var(--color-activity-code)' },
  user_joined: { icon: UserPlus, color: 'var(--color-activity-people)' },
};

const PAGE = 15;

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function dayLabel(ms: number, now = new Date()): string {
  const d = new Date(ms);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return d.toLocaleDateString('en-US', { weekday: 'long' });
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '';
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

const RepoLink: React.FC<{ path: string; search?: string }> = ({ path, search = '' }) => (
  <Link to={`/${path}${search}`} className="font-mono font-semibold text-txt-primary hover:text-txt-brand hover:underline">
    {path}
  </Link>
);

const ActorName: React.FC<{ e: ActivityEvent }> = ({ e }) => {
  if (!e.actor) return null;
  return e.actor.uid ? (
    <Link to={`/${e.actor.uid}`} className="font-semibold text-txt-primary hover:underline">
      {e.actor.display_name || e.actor.uid}
    </Link>
  ) : (
    <span className="font-semibold text-txt-primary">{e.actor.display_name}</span>
  );
};

function Sentence({ e }: { e: ActivityEvent }) {
  switch (e.kind) {
    case 'push':
      return <><ActorName e={e} /> pushed {e.count} {e.count === 1 ? 'commit' : 'commits'} to <RepoLink path={e.repo} search="?tab=commits" /></>;
    case 'pr_opened':
      return <><ActorName e={e} /> opened {e.draft ? 'a draft' : 'a'} pull request in <RepoLink path={e.repo} search="?tab=pulls" /></>;
    case 'pr_merged':
      return <><ActorName e={e} /> merged a pull request in <RepoLink path={e.repo} search="?tab=pulls" /></>;
    case 'pr_closed':
      return <>A pull request by <ActorName e={e} /> was closed in <RepoLink path={e.repo} search="?tab=pulls" /></>;
    case 'star':
      return <><ActorName e={e} /> starred <RepoLink path={e.repo} /></>;
    case 'repo_created':
      return <><ActorName e={e} /> created <RepoLink path={e.repo} /></>;
    case 'user_joined':
      return <><ActorName e={e} /> joined the forge <Sparkles className="inline w-3.5 h-3.5 -mt-0.5" style={{ color: KIND_STYLE.user_joined.color }} /></>;
    case 'deploy_live':
      return <><span className="font-semibold text-txt-primary">{e.service}</span> went live from <RepoLink path={e.repo} /></>;
    case 'deploy_failed':
      return <><span className="font-semibold text-txt-primary">{e.service}</span> failed to deploy from <RepoLink path={e.repo} /></>;
    case 'run_success':
    case 'run_failure':
      return <>
        <span className="font-semibold text-txt-primary">{e.workflow}</span> {e.kind === 'run_success' ? 'passed' : 'failed'} on <RepoLink path={e.repo} search="?tab=actions" />
        {e.actor && <> for <ActorName e={e} /></>}
      </>;
  }
}

function Detail({ e }: { e: ActivityEvent }) {
  const card = 'mt-2 rounded-md border border-border-subtle bg-surface-base text-xs';
  switch (e.kind) {
    case 'push':
      return (
        <ul className={`${card} divide-y divide-border-subtle`}>
          {e.commits.map(c => (
            <li key={c.sha}>
              <Link
                to={`/${e.repo}?tab=commits&commit=${c.sha}`}
                className="flex items-center gap-2.5 px-2.5 py-1.5 hover:bg-surface-subtle/60 transition min-w-0"
              >
                <code className="shrink-0 font-mono text-[11px] text-txt-brand">{c.short_sha}</code>
                <span className="truncate text-txt-secondary">{c.title}</span>
              </Link>
            </li>
          ))}
          {e.count > e.commits.length && (
            <li className="px-2.5 py-1.5 text-txt-tertiary">+ {e.count - e.commits.length} more</li>
          )}
        </ul>
      );
    case 'pr_opened':
    case 'pr_merged':
    case 'pr_closed':
      return (
        <Link
          to={`/${e.repo}?tab=pulls&pr=${e.number}`}
          className={`${card} flex items-center gap-2 px-2.5 py-2 hover:bg-surface-subtle/60 transition min-w-0`}
        >
          <span className="font-mono text-txt-tertiary shrink-0">#{e.number}</span>
          <span className="truncate text-txt-primary font-medium">{e.title}</span>
        </Link>
      );
    case 'deploy_live':
    case 'deploy_failed':
      return (
        <div className={`${card} flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 font-mono text-txt-secondary`}>
          {e.short_sha && <span className="text-txt-brand">{e.short_sha}</span>}
          {e.ref && <span>{e.ref}</span>}
          <span className="text-txt-tertiary">via {e.trigger}</span>
          {e.duration_ms != null && <span className="text-txt-tertiary">in {formatDuration(e.duration_ms)}</span>}
        </div>
      );
    case 'run_success':
    case 'run_failure':
      return (
        <Link
          to={`/${e.repo}?tab=actions&run=${e.run_number}`}
          className={`${card} flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-1.5 font-mono text-txt-secondary hover:bg-surface-subtle/60 transition`}
        >
          <span className="text-txt-tertiary">run #{e.run_number}</span>
          {e.ref && <span>{e.ref}</span>}
          {e.short_sha && <span className="text-txt-brand">{e.short_sha}</span>}
        </Link>
      );
    default:
      return null;
  }
}

const EventAvatar: React.FC<{ e: ActivityEvent }> = ({ e }) => {
  const { icon: Icon, color } = KIND_STYLE[e.kind];
  if (!e.actor) {
    return (
      <span
        className="flex items-center justify-center w-9 h-9 rounded-lg border border-border-subtle"
        style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
      >
        <Icon className="w-4 h-4" />
      </span>
    );
  }
  return (
    <span className="relative block w-9 h-9">
      <Avatar name={e.actor.uid || e.actor.display_name} url={e.actor.avatar_url} size={36} />
      <span
        className="absolute -bottom-1 -right-1 flex items-center justify-center w-[18px] h-[18px] rounded-full ring-2 ring-[var(--color-surface-canvas)]"
        style={{ background: color }}
      >
        <Icon className="w-2.5 h-2.5 text-white" strokeWidth={2.5} />
      </span>
    </span>
  );
};

export const ActivityFeedList: React.FC<{
  events: ActivityEvent[] | null;
  loading: boolean;
  error: boolean;
  signedIn: boolean;
  onRefresh: () => void;
}> = ({ events, loading, error, signedIn, onRefresh }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [shown, setShown] = useState(PAGE);
  const [, tick] = useState(0);

  // Keep "5m ago" honest without refetching.
  useEffect(() => {
    const id = window.setInterval(() => tick(n => n + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => setShown(PAGE), [filter]);

  const filtered = useMemo(() => {
    const kinds = FILTERS.find(f => f.key === filter)?.kinds;
    return (events ?? []).filter(e => !kinds || kinds.includes(e.kind));
  }, [events, filter]);

  const counts = useMemo(() => {
    const out: Partial<Record<Filter, number>> = {};
    for (const f of FILTERS) {
      out[f.key] = (events ?? []).filter(e => !f.kinds || f.kinds.includes(e.kind)).length;
    }
    return out;
  }, [events]);

  const groups = useMemo(() => {
    const out: { label: string; items: ActivityEvent[] }[] = [];
    for (const e of filtered.slice(0, shown)) {
      const label = dayLabel(e.at);
      const last = out[out.length - 1];
      if (last?.label === label) last.items.push(e);
      else out.push({ label, items: [e] });
    }
    return out;
  }, [filtered, shown]);

  return (
    <section data-testid="activity-feed" aria-label="Recent activity">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1" role="tablist" aria-label="Filter activity">
          {FILTERS.map(f => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`shrink-0 px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                filter === f.key
                  ? 'bg-txt-primary text-surface-canvas border-transparent'
                  : 'border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle'
              }`}
            >
              {f.label}
              {events && (counts[f.key] ?? 0) > 0 && (
                <span className={`ml-1.5 font-mono text-[10px] ${filter === f.key ? 'opacity-70' : 'text-txt-tertiary'}`}>
                  {counts[f.key]}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh activity"
          title="Refresh"
          className="shrink-0 p-1.5 rounded-md border border-border-subtle text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {loading && !events ? (
        <ul className="space-y-5" aria-hidden>
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex gap-3 animate-pulse">
              <span className="w-9 h-9 rounded-full bg-surface-subtle shrink-0" />
              <span className="flex-1 space-y-2 pt-1">
                <span className="block h-3 rounded bg-surface-subtle" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
                <span className="block h-8 rounded bg-surface-subtle/70" />
              </span>
            </li>
          ))}
        </ul>
      ) : error && !events ? (
        <div className="rounded-lg border border-dashed border-border-subtle p-8 text-center text-sm text-txt-secondary">
          Couldn’t load activity.{' '}
          <button type="button" onClick={onRefresh} className="text-txt-brand hover:underline">Try again</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border-subtle p-10 text-center">
          <ActivityIcon className="w-9 h-9 mx-auto mb-3 text-txt-tertiary opacity-60" />
          <h3 className="text-sm font-semibold text-txt-primary">
            {filter === 'all' ? 'No activity yet' : 'Nothing here in the last 30 days'}
          </h3>
          <p className="mt-1 text-xs text-txt-secondary max-w-xs mx-auto">
            {signedIn
              ? 'Push some commits, open a pull request or deploy a service and it will show up here.'
              : 'Public activity on this instance will show up here.'}
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(g => (
            <div key={g.label}>
              <h3 className="sticky top-0 z-10 -mx-1 px-1 py-1 mb-2 text-[11px] font-semibold uppercase tracking-wider text-txt-tertiary bg-surface-base">
                {g.label}
              </h3>
              <ol className="relative">
                {g.items.map((e, i) => (
                  <li key={e.id} className="relative flex gap-3 pb-5 last:pb-0 activity-rise" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                    {i < g.items.length - 1 && (
                      <span aria-hidden className="absolute left-[18px] top-11 bottom-1 w-px bg-border-subtle" />
                    )}
                    <div className="shrink-0">
                      <EventAvatar e={e} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <div className="flex items-start justify-between gap-3">
                        <p className="text-sm text-txt-secondary leading-snug min-w-0 break-words">
                          <Sentence e={e} />
                        </p>
                        <time
                          dateTime={new Date(e.at).toISOString()}
                          title={new Date(e.at).toLocaleString()}
                          className="shrink-0 text-[11px] font-mono text-txt-tertiary pt-0.5"
                        >
                          {timeAgo(e.at)}
                        </time>
                      </div>
                      <Detail e={e} />
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {filtered.length > shown && (
            <button
              type="button"
              onClick={() => setShown(n => n + PAGE)}
              className="w-full py-2 rounded-md border border-border-subtle text-xs font-medium text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
            >
              Show more ({filtered.length - shown} older)
            </button>
          )}
        </div>
      )}
    </section>
  );
};

export const TopContributors: React.FC<{ contributors: ActivityContributor[] }> = ({ contributors }) => {
  if (!contributors.length) return null;
  const top = contributors[0].count || 1;
  return (
    <section className="border-t border-border-subtle pt-6 space-y-3" data-testid="top-contributors">
      <h2 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider flex items-center gap-1.5">
        <Flame className="w-3.5 h-3.5" style={{ color: 'var(--color-activity-star)' }} />
        <span>Most active this week</span>
      </h2>
      <ol className="space-y-2.5">
        {contributors.map((c, i) => {
          const body = (
            <>
              <span className="w-4 text-[11px] font-mono text-txt-tertiary text-right">{i + 1}</span>
              <Avatar name={c.uid || c.display_name} url={c.avatar_url} size={26} />
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-xs font-medium text-txt-primary">{c.display_name || c.uid}</span>
                  <span className="shrink-0 text-[10px] font-mono text-txt-tertiary">
                    {[c.commits && `${c.commits} commits`, c.prs && `${c.prs} PRs`].filter(Boolean).join(' · ') || `${c.count} events`}
                  </span>
                </span>
                <span className="mt-1 block h-1 rounded-full bg-surface-subtle overflow-hidden">
                  <span
                    className="block h-full rounded-full"
                    style={{
                      width: `${Math.max(6, (c.count / top) * 100)}%`,
                      background: 'linear-gradient(90deg, var(--color-activity-code), var(--color-activity-merged))',
                    }}
                  />
                </span>
              </span>
            </>
          );
          return (
            <li key={c.uid || c.display_name}>
              {c.uid ? (
                <Link to={`/${c.uid}`} className="flex items-center gap-2.5 rounded hover:bg-surface-subtle/60 -mx-1 px-1 py-0.5 transition">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-2.5 -mx-1 px-1 py-0.5">{body}</div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
};

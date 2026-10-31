// Dashboard hero: greeting, headline numbers and a 30-day stacked activity
// chart. Hand-built like ContributionGraph — no charting dependency.
import React, { useMemo, useState } from 'react';
import { GitCommitHorizontal, GitPullRequest, Rocket, Users, FolderGit2, TrendingUp, TrendingDown } from 'lucide-react';
import { ActivityDay, ActivityFeed, User } from '../lib/api';

const SERIES = [
  { key: 'commits', label: 'Commits', color: 'var(--color-activity-code)' },
  { key: 'prs', label: 'Pull requests', color: 'var(--color-activity-merged)' },
  { key: 'other', label: 'Deploys, CI & more', color: 'var(--color-activity-ship)' },
] as const;

function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h < 5) return 'Burning the midnight oil';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

const total = (d: ActivityDay) => d.commits + d.prs + d.other;

function prettyDay(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

const Stat: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: number | string;
  hint?: React.ReactNode;
}> = ({ icon, label, value, hint }) => (
  <div className="min-w-0">
    <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-txt-tertiary font-medium">
      {icon}
      <span className="truncate">{label}</span>
    </div>
    <div className="mt-1 flex items-baseline gap-2">
      <span className="text-2xl font-semibold tabular-nums text-txt-primary">{value}</span>
      {hint}
    </div>
  </div>
);

export const ActivityPulse: React.FC<{ user: User | null; feed: ActivityFeed | null; loading: boolean }> = ({ user, feed, loading }) => {
  const [hover, setHover] = useState<number | null>(null);
  const daily = feed?.daily ?? [];
  const max = Math.max(1, ...daily.map(total));

  const { last7, prev7, summary, busiest } = useMemo(() => {
    const sum = (days: ActivityDay[], k: 'commits' | 'prs' | 'other') => days.reduce((a, d) => a + d[k], 0);
    const l7 = daily.slice(-7);
    const p7 = daily.slice(-14, -7);
    const best = daily.reduce<ActivityDay | null>((b, d) => (total(d) > (b ? total(b) : 0) ? d : b), null);
    return {
      last7: sum(l7, 'commits'),
      prev7: sum(p7, 'commits'),
      summary: { commits: sum(l7, 'commits'), prs: sum(l7, 'prs'), other: sum(l7, 'other') },
      busiest: best,
    };
  }, [daily]);

  const trend = prev7 > 0 ? Math.round(((last7 - prev7) / prev7) * 100) : null;
  const stats = feed?.stats;
  const hovered = hover != null ? daily[hover] : null;
  const name = user?.display_name || user?.uid;

  return (
    <section
      className="mb-8 pb-8 border-b border-border-subtle"
      data-testid="activity-pulse"
    >
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-5 flex flex-col justify-between gap-5 min-w-0">
          <div>
            <p className="text-xs font-mono uppercase tracking-[0.2em] text-txt-tertiary">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            <h1 className="mt-1 text-2xl sm:text-3xl font-bold tracking-tight text-txt-primary">
              {user ? `${greeting()}, ${name}` : 'What’s happening on this forge'}
            </h1>
            <p className="mt-2 text-sm text-txt-secondary">
              {loading
                ? 'Gathering the latest activity…'
                : summary.commits + summary.prs + summary.other === 0
                  ? 'All quiet this week. A perfect time to ship something.'
                  : (
                    <>
                      <strong className="text-txt-primary font-semibold">{stats?.commits_7d ?? summary.commits}</strong> commits,{' '}
                      <strong className="text-txt-primary font-semibold">{summary.prs}</strong> pull request events and{' '}
                      <strong className="text-txt-primary font-semibold">{summary.other}</strong> deploys, runs &amp; stars in the last 7 days.
                    </>
                  )}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-border-subtle pt-5">
            <Stat
              icon={<GitCommitHorizontal className="w-3.5 h-3.5" />}
              label="Commits · 7d"
              value={loading ? '–' : stats?.commits_7d ?? 0}
              hint={trend != null && !loading && (
                <span
                  className={`inline-flex items-center gap-0.5 text-[11px] font-mono ${trend >= 0 ? 'text-txt-open' : 'text-feedback-error-text'}`}
                  title="Compared with the 7 days before"
                >
                  {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                  {trend >= 0 ? '+' : ''}{trend}%
                </span>
              )}
            />
            <Stat icon={<GitPullRequest className="w-3.5 h-3.5" />} label="Open PRs" value={loading ? '–' : stats?.open_prs ?? 0} />
            <Stat icon={<Users className="w-3.5 h-3.5" />} label="Active · 7d" value={loading ? '–' : stats?.contributors_7d ?? 0}
              hint={stats?.members != null && !loading && (
                <span className="text-[11px] font-mono text-txt-tertiary">of {stats.members}</span>
              )}
            />
            {stats && stats.live_services > 0 ? (
              <Stat icon={<Rocket className="w-3.5 h-3.5" />} label="Live services" value={stats.live_services}
                hint={<span className="relative flex w-2 h-2" aria-hidden><span className="absolute inline-flex w-full h-full rounded-full bg-[var(--color-activity-pr)] opacity-60 animate-ping" /><span className="relative inline-flex w-2 h-2 rounded-full bg-[var(--color-activity-pr)]" /></span>}
              />
            ) : (
              <Stat icon={<FolderGit2 className="w-3.5 h-3.5" />} label="Repositories" value={loading ? '–' : stats?.repos ?? 0} />
            )}
          </div>
        </div>

        <div className="lg:col-span-7 flex flex-col min-w-0">
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-txt-tertiary">
              Last {feed?.window_days ?? 30} days
            </h2>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-txt-secondary">
              {SERIES.map(s => (
                <span key={s.key} className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>

          <div className="relative flex-1 flex flex-col min-h-[160px] pt-8 pb-2">
            <div className="absolute left-3 right-3 top-2 h-5 text-[11px] font-mono text-txt-secondary truncate" aria-live="polite">
              {hovered ? (
                <>
                  <span className="text-txt-primary font-semibold">{prettyDay(hovered.date)}</span>
                  {' · '}{hovered.commits} commits · {hovered.prs} PR · {hovered.other} other
                </>
              ) : busiest && total(busiest) > 0 ? (
                <>Busiest day: <span className="text-txt-primary">{prettyDay(busiest.date)}</span> with {total(busiest)} events</>
              ) : null}
            </div>
            <div
              className="flex-1 flex items-end gap-[3px] min-h-[110px]"
              role="img"
              aria-label={`Activity over the last ${daily.length} days`}
              onMouseLeave={() => setHover(null)}
            >
              {(loading ? Array.from({ length: 30 }, () => null) : daily).map((d, i) => {
                if (!d) {
                  return <div key={i} className="flex-1 rounded-sm bg-surface-subtle animate-pulse" style={{ height: `${20 + ((i * 37) % 60)}%` }} />;
                }
                const t = total(d);
                const isToday = i === daily.length - 1;
                return (
                  <div
                    key={d.date}
                    data-testid="activity-bar"
                    className={`group relative flex-1 h-full flex flex-col justify-end cursor-default transition-opacity ${hover != null && hover !== i ? 'opacity-50' : ''}`}
                    onMouseEnter={() => setHover(i)}
                    title={`${prettyDay(d.date)}: ${t} events`}
                  >
                    {t === 0 ? (
                      <div className="h-[3px] rounded-sm bg-border-subtle" />
                    ) : (
                      <div
                        className="w-full rounded-[3px] overflow-hidden flex flex-col-reverse origin-bottom activity-rise"
                        style={{ height: `${Math.max(6, (t / max) * 100)}%`, animationDelay: `${i * 12}ms` }}
                      >
                        {SERIES.map(s => d[s.key] > 0 && (
                          <div key={s.key} style={{ flexGrow: d[s.key], background: s.color }} />
                        ))}
                      </div>
                    )}
                    {isToday && <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-txt-primary" aria-hidden />}
                  </div>
                );
              })}
            </div>
            <div className="mt-2 flex justify-between text-[10px] font-mono text-txt-tertiary">
              <span>{daily[0] ? prettyDay(daily[0].date) : ''}</span>
              <span>Today</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};

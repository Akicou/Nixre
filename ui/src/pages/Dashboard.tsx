import React, { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  GitPullRequest,
  FolderGit2,
  Layers,
  Search,
  Terminal,
  ArrowRight,
  Star,
  Activity,
} from 'lucide-react';
import { api, ActivityFeed, Repository, Space, User } from '../lib/api';
import { Avatar } from '../components/Avatar';
import { DeploymentsOverview } from '../components/DeploymentsOverview';
import { ActivityPulse } from '../components/ActivityPulse';
import { ActivityFeedList, TopContributors } from '../components/ActivityFeed';

interface DashboardProps {
  user: User | null;
}

type Tab = 'activity' | 'repos';

export const Dashboard: React.FC<DashboardProps> = ({ user }) => {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  // Guests land on an explore view, where the most-starred repos lead.
  const [sort, setSort] = useState<'name' | 'stars'>(user ? 'name' : 'stars');
  const [feed, setFeed] = useState<ActivityFeed | null>(null);
  const [feedLoading, setFeedLoading] = useState(true);
  const [feedError, setFeedError] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // Guests land on the explore list; signed-in people on what's new.
  const defaultTab: Tab = user ? 'activity' : 'repos';
  const tabParam = searchParams.get('tab');
  const tab: Tab = tabParam === 'repos' || tabParam === 'activity' ? tabParam : defaultTab;

  useEffect(() => {
    Promise.all([
      api.listSpaces().catch(() => []),
      api.listRepos().catch(() => []),
    ]).then(([s, r]) => {
      setSpaces(s);
      setRepos(r);
      setLoading(false);
    });
  }, []);

  const loadFeed = useCallback(() => {
    setFeedLoading(true);
    // Older backends (or test mocks) without the endpoint just get an empty feed.
    Promise.resolve()
      .then(() => api.getActivity(80))
      .then(f => { setFeed(f); setFeedError(false); })
      .catch(() => setFeedError(true))
      .finally(() => setFeedLoading(false));
  }, []);

  useEffect(loadFeed, [loadFeed]);

  const selectTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams);
    if (next === defaultTab) params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };

  const quickStartRepoPath = repos[0]?.path || 'your-space/your-repo';

  const filteredRepos = [...repos]
    .sort((a, b) => (sort === 'stars' ? (b.stars ?? 0) - (a.stars ?? 0) : 0) || a.path.localeCompare(b.path))
    .filter(r =>
    r.uid.toLowerCase().includes(search.toLowerCase()) || 
    (r.description && r.description.toLowerCase().includes(search.toLowerCase())) ||
    (r.path && r.path.toLowerCase().includes(search.toLowerCase()))
  );

  const tabClass = (active: boolean) =>
    `flex items-center gap-1.5 px-1 pb-2.5 -mb-px border-b-2 text-sm font-medium transition ${
      active ? 'border-brand text-txt-primary' : 'border-transparent text-txt-secondary hover:text-txt-primary'
    }`;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 w-full min-w-0">
      <ActivityPulse user={user} feed={feed} loading={feedLoading && !feed} />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 xl:gap-8">
        {/* Main Repositories List */}
        <div className="lg:col-span-8 space-y-6 min-w-0">
          <div className="flex items-end justify-between gap-3 border-b border-border-subtle">
            <div className="flex items-center gap-5" role="tablist" aria-label="Dashboard sections">
              <button type="button" role="tab" aria-selected={tab === 'activity'} onClick={() => selectTab('activity')} className={tabClass(tab === 'activity')}>
                <Activity className="w-4 h-4" />
                <span>Activity</span>
              </button>
              <button type="button" role="tab" aria-selected={tab === 'repos'} onClick={() => selectTab('repos')} className={tabClass(tab === 'repos')}>
                <FolderGit2 className="w-4 h-4" />
                <span>Repositories</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-subtle text-txt-secondary font-mono border border-border-subtle">
                  {repos.length}
                </span>
              </button>
            </div>
          </div>

          {tab === 'activity' && (
            <>
              {user && <DeploymentsOverview />}
              <ActivityFeedList
                events={feed?.events ?? null}
                loading={feedLoading}
                error={feedError}
                signedIn={Boolean(user)}
                onRefresh={loadFeed}
              />
            </>
          )}

          {tab === 'repos' && (<>
          {/* Search Bar */}
          <div className="flex gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-txt-tertiary" />
            <input
              type="text"
              placeholder="Filter repositories by name or description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary placeholder:text-txt-tertiary text-sm focus:border-brand transition"
            />
          </div>
          <select
            aria-label="Sort repositories"
            value={sort}
            onChange={e => setSort(e.target.value as 'name' | 'stars')}
            className="rounded-md border border-border-subtle bg-surface-canvas px-2 text-sm text-txt-primary"
          >
            <option value="name">Name</option>
            <option value="stars">Most starred</option>
          </select>
          </div>

          {loading ? (
            <div className="py-16 text-center text-sm text-txt-tertiary">Loading repositories...</div>
          ) : filteredRepos.length === 0 ? (
            <div className="border border-dashed border-border-subtle rounded-lg p-12 text-center bg-surface-canvas/50">
              <FolderGit2 className="w-10 h-10 text-txt-tertiary mx-auto mb-3 opacity-60" />
              <h3 className="text-base font-semibold text-txt-primary">No repositories found</h3>
              <p className="text-sm text-txt-secondary mt-1 max-w-sm mx-auto">
                {user
                  ? 'Get started by creating your first repository or importing existing Git projects.'
                  : 'There are no public repositories on this instance yet.'}
              </p>
              {user && (
              <div className="mt-4 flex justify-center gap-3">
                <Link
                  to="/new-repo"
                  className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
                >
                  Create Repository
                </Link>
              </div>
              )}
            </div>
          ) : (
            <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden divide-y divide-border-subtle">
              {filteredRepos.map(repo => (
                <div key={repo.id} className="p-4 hover:bg-surface-subtle/50 transition flex items-start justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <FolderGit2 className="w-4 h-4 text-brand shrink-0" />
                      <Link
                        to={`/${repo.path}`}
                        className="font-mono text-sm font-semibold text-txt-brand hover:underline truncate"
                      >
                        {repo.path}
                      </Link>
                      <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                        {repo.is_public ? 'Public' : 'Private'}
                      </span>
                    </div>

                    {repo.description && (
                      <p className="text-xs text-txt-secondary line-clamp-2">
                        {repo.description}
                      </p>
                    )}

                    <div className="flex items-center gap-4 text-xs text-txt-tertiary font-mono pt-1">
                      <span>branch: {repo.default_branch || 'main'}</span>
                      {(repo.stars ?? 0) > 0 && (
                        <span className="flex items-center gap-1" aria-label={`${repo.stars} stars`}>
                          <Star className="w-3.5 h-3.5" />
                          <span>{repo.stars}</span>
                        </span>
                      )}
                      {repo.num_open_pulls > 0 && (
                        <span className="flex items-center gap-1 text-txt-open">
                          <GitPullRequest className="w-3.5 h-3.5" />
                          <span>{repo.num_open_pulls} PRs</span>
                        </span>
                      )}
                    </div>
                  </div>

                  <Link
                    to={`/${repo.path}`}
                    className="shrink-0 p-1.5 rounded hover:bg-surface-subtle text-txt-tertiary hover:text-txt-primary transition"
                  >
                    <ArrowRight className="w-4 h-4" />
                  </Link>
                </div>
              ))}
            </div>
          )}
          </>)}
        </div>

        {/* Sidebar: who is active, spaces & quick info */}
        <div className="lg:col-span-4 space-y-6">
          {user && (
            <Link
              to={`/${user.uid}`}
              className="flex items-center gap-3 border border-border-subtle rounded-lg bg-surface-canvas p-3 hover:bg-surface-subtle/60 transition"
            >
              <Avatar name={user.uid} url={user.avatar_url} size={36} />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold text-txt-primary truncate">{user.display_name || user.uid}</span>
                <span className="block text-xs text-txt-tertiary font-mono truncate">@{user.uid} · My Profile</span>
              </span>
              <ArrowRight className="w-4 h-4 text-txt-tertiary" />
            </Link>
          )}

          {feed && <TopContributors contributors={feed.contributors} />}

          {/* Spaces Sidebar Section */}
          <div className="border border-border-subtle rounded-lg bg-surface-canvas p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                <span>Namespaces</span>
              </h2>
              {user && (
                <Link to="/new-space" className="text-xs text-txt-brand hover:underline font-medium">
                  + New
                </Link>
              )}
            </div>

            {spaces.length === 0 ? (
              <p className="text-xs text-txt-tertiary">No spaces created yet.</p>
            ) : (
              <div className="space-y-1">
                {spaces.map(s => (
                  <Link
                    key={s.uid}
                    to={`/${s.uid}`}
                    className="flex items-center justify-between p-2 rounded hover:bg-surface-subtle transition text-xs font-medium text-txt-primary"
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <Avatar name={s.uid} url={s.avatar_url} size={18} />
                      <span className="font-mono truncate">{s.uid}</span>
                    </span>
                    <span className="text-[10px] text-txt-tertiary uppercase font-mono">
                      {s.is_public ? 'Public' : 'Private'}
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {/* Quick Git Commands Card */}
          <div className="border border-border-subtle rounded-lg bg-surface-canvas p-4 space-y-3">
            <h2 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider flex items-center gap-1.5">
              <Terminal className="w-3.5 h-3.5" />
              <span>Git Quick Start</span>
            </h2>

            <div className="bg-surface-base border border-border-subtle rounded p-2.5 font-mono text-[11px] text-txt-secondary space-y-2 overflow-x-auto">
              <p className="text-txt-tertiary font-sans text-xs"># Clone existing repo:</p>
              <p className="text-txt-primary">git clone {window.location.origin}/git/{quickStartRepoPath}.git</p>
              {user && (
                <>
                  <p className="text-txt-tertiary font-sans text-xs pt-1"># Push existing local repo:</p>
                  <p>git remote add origin {window.location.origin}/git/{quickStartRepoPath}.git</p>
                  <p>git push -u origin main</p>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  GitPullRequest,
  FolderGit2,
  Layers,
  Search,
  Terminal,
  ArrowRight
} from 'lucide-react';
import { api, Repository, Space, User } from '../lib/api';
import { Avatar } from '../components/Avatar';

interface DashboardProps {
  user: User | null;
}

export const Dashboard: React.FC<DashboardProps> = ({ user }) => {
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

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

  const quickStartRepoPath = repos[0]?.path || 'your-space/your-repo';

  const filteredRepos = repos.filter(r =>
    r.uid.toLowerCase().includes(search.toLowerCase()) || 
    (r.description && r.description.toLowerCase().includes(search.toLowerCase())) ||
    (r.path && r.path.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 w-full min-w-0">
      {/* Top Banner & Quick Stats */}
      <div className="mb-8 border-b border-border-subtle pb-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-txt-primary flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Repositories & Spaces</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-surface-subtle text-txt-secondary font-mono border border-border-subtle font-normal">
              {repos.length} repos
            </span>
          </h1>
          <p className="text-sm text-txt-secondary mt-1">
            Sovereign Git forge powered by fast Go backend & modern minimalist interface.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {user && (
            <Link
              to={`/${user.uid}`}
              className="px-3 py-1.5 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle border border-border-subtle transition font-medium flex items-center gap-1.5"
            >
              <span className="flex items-center gap-1.5">
                <Avatar name={user.uid} url={user.avatar_url} size={20} />
                <span>My Profile</span>
              </span>
            </Link>
          )}
          <Link
            to="/new-space"
            className="px-3 py-1.5 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle border border-border-subtle transition font-medium flex items-center gap-1.5"
          >
            <Layers className="w-4 h-4 text-txt-tertiary" />
            <span>New Space</span>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 xl:gap-8">
        {/* Main Repositories List */}
        <div className="lg:col-span-8 space-y-6">
          {/* Search Bar */}
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-txt-tertiary" />
            <input
              type="text"
              placeholder="Filter repositories by name or description..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary placeholder:text-txt-tertiary text-sm focus:border-brand transition"
            />
          </div>

          {loading ? (
            <div className="py-16 text-center text-sm text-txt-tertiary">Loading repositories...</div>
          ) : filteredRepos.length === 0 ? (
            <div className="border border-dashed border-border-subtle rounded-lg p-12 text-center bg-surface-canvas/50">
              <FolderGit2 className="w-10 h-10 text-txt-tertiary mx-auto mb-3 opacity-60" />
              <h3 className="text-base font-semibold text-txt-primary">No repositories found</h3>
              <p className="text-sm text-txt-secondary mt-1 max-w-sm mx-auto">
                Get started by creating your first repository or importing existing Git projects.
              </p>
              <div className="mt-4 flex justify-center gap-3">
                <Link
                  to="/new-repo"
                  className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
                >
                  Create Repository
                </Link>
              </div>
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
        </div>

        {/* Sidebar: Spaces & Quick Info */}
        <div className="lg:col-span-4 space-y-6">
          {/* Spaces Sidebar Section */}
          <div className="border border-border-subtle rounded-lg bg-surface-canvas p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                <span>Namespaces</span>
              </h2>
              <Link to="/new-space" className="text-xs text-txt-brand hover:underline font-medium">
                + New
              </Link>
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
              <p className="text-txt-tertiary font-sans text-xs pt-1"># Push existing local repo:</p>
              <p>git remote add origin {window.location.origin}/git/{quickStartRepoPath}.git</p>
              <p>git push -u origin main</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

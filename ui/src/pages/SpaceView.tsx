import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Layers, FolderGit2, Plus, ArrowRight, Globe, Lock, ArrowLeft } from 'lucide-react';
import { api, Space, Repository } from '../lib/api';

export const SpaceView: React.FC = () => {
  const { space: spaceUid } = useParams<{ space: string }>();
  const [space, setSpace] = useState<Space | null>(null);
  const [repos, setRepos] = useState<Repository[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!spaceUid) return;
    setLoading(true);
    Promise.all([
      api.getSpace(spaceUid),
      api.listRepos(spaceUid),
    ])
      .then(([s, r]) => {
        setSpace(s);
        setRepos(r);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Space not found');
        setLoading(false);
      });
  }, [spaceUid]);

  if (loading) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-sm text-txt-tertiary">Loading space...</div>;
  }

  if (error || !space) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <h2 className="text-lg font-bold text-txt-primary">Space not found</h2>
        <p className="text-sm text-txt-secondary">{error || 'The requested space does not exist.'}</p>
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-brand hover:underline">
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Space Header */}
      <div className="border-b border-border-subtle pb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded bg-surface-subtle border border-border-subtle flex items-center justify-center font-mono text-base font-bold text-txt-primary">
            {space.uid.slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-bold font-mono text-txt-primary">{space.uid}</h1>
              <span className="text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle text-txt-tertiary">
                {space.is_public ? 'Public' : 'Private'}
              </span>
            </div>
            {space.description && (
              <p className="text-xs text-txt-secondary mt-0.5">{space.description}</p>
            )}
          </div>
        </div>

        <Link
          to="/new-repo"
          className="px-3.5 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm flex items-center gap-1.5 self-start sm:self-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>New Repository in {space.uid}</span>
        </Link>
      </div>

      {/* Repositories in this Space */}
      <div className="space-y-4">
        <h2 className="text-sm font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-2">
          <FolderGit2 className="w-4 h-4 text-brand" />
          <span>Repositories ({repos.length})</span>
        </h2>

        {repos.length === 0 ? (
          <div className="border border-dashed border-border-subtle rounded-lg p-10 text-center bg-surface-canvas/50">
            <p className="text-sm text-txt-secondary">No repositories in this space yet.</p>
            <Link
              to="/new-repo"
              className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover transition shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create first repository</span>
            </Link>
          </div>
        ) : (
          <div className="border border-border-subtle rounded-lg bg-surface-canvas divide-y divide-border-subtle overflow-hidden">
            {repos.map(r => (
              <div key={r.id} className="p-4 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <FolderGit2 className="w-4 h-4 text-brand" />
                    <Link
                      to={`/${r.path}`}
                      className="font-mono text-sm font-semibold text-txt-brand hover:underline"
                    >
                      {r.uid}
                    </Link>
                    <span className="text-[10px] font-mono uppercase px-1.5 py-0.2 rounded border border-border-subtle text-txt-tertiary">
                      {r.is_public ? 'Public' : 'Private'}
                    </span>
                  </div>
                  {r.description && <p className="text-xs text-txt-secondary">{r.description}</p>}
                </div>

                <Link
                  to={`/${r.path}`}
                  className="p-1.5 rounded hover:bg-surface-subtle text-txt-tertiary hover:text-txt-primary transition"
                >
                  <ArrowRight className="w-4 h-4" />
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

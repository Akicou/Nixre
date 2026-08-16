import React, { useState, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { FolderGit2, ArrowLeft } from 'lucide-react';
import { api, Space } from '../lib/api';

export const NewRepo: React.FC = () => {
  const navigate = useNavigate();
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [parentRef, setParentRef] = useState('');
  const [uid, setUid] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [readme, setReadme] = useState(true);
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.listSpaces().then(res => {
      setSpaces(res);
      if (res.length > 0) setParentRef(res[0].uid);
    }).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const repo = await api.createRepo(parentRef, uid, description, isPublic, readme, defaultBranch);
      navigate(`/${repo.path}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create repository');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-4 py-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-secondary hover:text-txt-primary mb-6 transition">
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Dashboard</span>
      </Link>

      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 sm:p-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-txt-primary flex items-center gap-2">
            <FolderGit2 className="w-5 h-5 text-brand" />
            <span>Create a new repository</span>
          </h1>
          <p className="text-xs text-txt-secondary mt-1">
            A repository contains all project files, including the revision history.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
                Owner / Space *
              </label>
              <select
                value={parentRef}
                onChange={e => setParentRef(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
                required
              >
                {spaces.map(s => (
                  <option key={s.uid} value={s.uid}>{s.uid}</option>
                ))}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
                Repository Name *
              </label>
              <input
                type="text"
                placeholder="e.g. awesome-app"
                value={uid}
                onChange={e => setUid(e.target.value)}
                className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Description (Optional)
            </label>
            <textarea
              rows={2}
              placeholder="Short description of this project"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-border-subtle">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="isPublic"
                checked={isPublic}
                onChange={e => setIsPublic(e.target.checked)}
                className="rounded border-border-subtle text-brand focus:ring-0"
              />
              <label htmlFor="isPublic" className="text-xs text-txt-primary font-medium cursor-pointer">
                Public repository (anyone with URL can read)
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="readme"
                checked={readme}
                onChange={e => setReadme(e.target.checked)}
                className="rounded border-border-subtle text-brand focus:ring-0"
              />
              <label htmlFor="readme" className="text-xs text-txt-primary font-medium cursor-pointer">
                Initialize with a README.md
              </label>
            </div>
          </div>

          <div className="pt-4 flex justify-end gap-3 border-t border-border-subtle">
            <Link
              to="/"
              className="px-4 py-2 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition font-medium"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={loading || !uid}
              className="px-4 py-2 rounded bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm"
            >
              {loading ? 'Creating...' : 'Create Repository'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

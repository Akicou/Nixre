import React, { useState, useEffect } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings as SettingsIcon, Trash2, Save, Globe, Lock } from 'lucide-react';
import { api, Repository } from '../lib/api';

export const RepoSettings: React.FC = () => {
  const { space, repo: repoUid } = useParams<{ space: string; repo: string }>();
  const navigate = useNavigate();
  const repoPath = `${space}/${repoUid}`;

  const [repo, setRepo] = useState<Repository | null>(null);
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!space || !repoUid) return;
    setLoading(true);
    api.getRepo(repoPath)
      .then(r => {
        setRepo(r);
        setDescription(r.description || '');
        setIsPublic(r.is_public);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load repository');
        setLoading(false);
      });
  }, [repoPath]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const updated = await api.updateRepo(repoPath, { description, is_public: isPublic });
      setRepo(updated);
      setSuccess('Repository settings saved.');
    } catch (err: any) {
      setError(err.message || 'Failed to save repository settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!repo || confirmText !== repo.uid) return;
    setError('');
    setDeleting(true);
    try {
      await api.deleteRepo(repoPath);
      navigate(`/${space}`);
    } catch (err: any) {
      setError(err.message || 'Failed to delete repository.');
      setDeleting(false);
    }
  };

  if (loading && !repo) {
    return <div className="max-w-7xl mx-auto px-4 py-16 text-center text-sm text-txt-tertiary">Loading repository settings...</div>;
  }

  if (error && !repo) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center space-y-4">
        <h2 className="text-lg font-bold text-txt-primary">Repository not found</h2>
        <p className="text-sm text-txt-secondary">{error}</p>
        <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-brand hover:underline">
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Dashboard</span>
        </Link>
      </div>
    );
  }

  if (!repo) return null;

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* Header */}
      <div>
        <Link
          to={`/${repoPath}`}
          className="inline-flex items-center gap-1.5 text-xs text-txt-secondary hover:text-txt-primary mb-4 transition"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to repository</span>
        </Link>

        <div className="border-b border-border-subtle pb-4 flex items-center justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-bold text-txt-primary flex items-center gap-2">
              <SettingsIcon className="w-5 h-5 text-brand" />
              <span>Repository Settings</span>
            </h1>
            <p className="text-xs font-mono text-txt-secondary">
              {repoPath}
              <span className={`ml-2 text-[10px] uppercase font-mono px-1.5 py-0.5 rounded border border-border-subtle ${repo.is_public ? 'text-txt-tertiary' : 'text-txt-tertiary'}`}>
                {repo.is_public ? 'Public' : 'Private'}
              </span>
            </p>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
          {error}
        </div>
      )}
      {success && (
        <div className="p-3 rounded bg-feedback-success-bg border border-feedback-success-border text-feedback-success-text text-xs">
          {success}
        </div>
      )}

      {/* General */}
      <form onSubmit={handleSave} className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-5">
        <div>
          <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider">General</h2>
          <p className="text-xs text-txt-secondary mt-0.5">Repository description and visibility.</p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
            Description
          </label>
          <textarea
            rows={3}
            placeholder="Short description of this project"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
          />
        </div>

        <div>
          <span className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-2">
            Visibility
          </span>
          <div className="flex flex-col sm:flex-row gap-3">
            <button
              type="button"
              onClick={() => setIsPublic(true)}
              className={`flex-1 flex items-center gap-2 px-4 py-3 rounded-md border text-left text-xs transition ${
                isPublic ? 'border-brand bg-surface-subtle' : 'border-border-subtle bg-surface-base hover:bg-surface-subtle/50'
              }`}
            >
              <Globe className={`w-4 h-4 shrink-0 ${isPublic ? 'text-brand' : 'text-txt-tertiary'}`} />
              <span>
                <span className="block font-semibold text-txt-primary">Public</span>
                <span className="block text-txt-tertiary text-[11px]">Anyone with the URL can read</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => setIsPublic(false)}
              className={`flex-1 flex items-center gap-2 px-4 py-3 rounded-md border text-left text-xs transition ${
                !isPublic ? 'border-brand bg-surface-subtle' : 'border-border-subtle bg-surface-base hover:bg-surface-subtle/50'
              }`}
            >
              <Lock className={`w-4 h-4 shrink-0 ${!isPublic ? 'text-brand' : 'text-txt-tertiary'}`} />
              <span>
                <span className="block font-semibold text-txt-primary">Private</span>
                <span className="block text-txt-tertiary text-[11px]">Only you and collaborators</span>
              </span>
            </button>
          </div>
        </div>

        <div className="pt-4 flex justify-end border-t border-border-subtle">
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 rounded bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-1.5"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Saving...' : 'Save Changes'}</span>
          </button>
        </div>
      </form>

      {/* Danger Zone */}
      <div className="border border-feedback-error-border rounded-lg bg-surface-canvas p-6 space-y-4">
        <div>
          <h2 className="text-sm font-semibold text-feedback-error-text uppercase tracking-wider">Danger Zone</h2>
          <p className="text-xs text-txt-secondary mt-0.5">
            Permanently delete this repository and all of its contents. This cannot be undone.
          </p>
        </div>

        {!confirmOpen ? (
          <button
            onClick={() => setConfirmOpen(true)}
            className="px-4 py-2 rounded border border-feedback-error-border text-feedback-error-text text-xs font-semibold hover:bg-feedback-error-bg transition flex items-center gap-1.5"
          >
            <Trash2 className="w-4 h-4" />
            <span>Delete repository</span>
          </button>
        ) : (
          <div className="space-y-3">
            <p className="text-xs text-txt-primary">
              To confirm, type the repository name <code className="font-mono font-semibold">{repo.uid}</code> below.
            </p>
            <input
              type="text"
              placeholder={repo.uid}
              value={confirmText}
              onChange={e => setConfirmText(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-feedback-error-border transition"
            />
            <div className="flex gap-3">
              <button
                onClick={handleDelete}
                disabled={deleting || confirmText !== repo.uid}
                className="px-4 py-2 rounded bg-feedback-error-bg text-feedback-error-text text-xs font-semibold hover:bg-feedback-error-bg-selected disabled:opacity-50 transition flex items-center gap-1.5 border border-feedback-error-border"
              >
                <Trash2 className="w-4 h-4" />
                <span>{deleting ? 'Deleting...' : 'Delete permanently'}</span>
              </button>
              <button
                onClick={() => { setConfirmOpen(false); setConfirmText(''); }}
                className="px-4 py-2 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition font-medium"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

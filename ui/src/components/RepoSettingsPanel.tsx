import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Trash2, Save, Globe, Lock } from 'lucide-react';
import { api, Repository } from '../lib/api';

interface RepoSettingsPanelProps {
  repo: Repository;
  repoPath: string;
  space: string;
  onUpdated: (repo: Repository) => void;
}

export const RepoSettingsPanel: React.FC<RepoSettingsPanelProps> = ({ repo, repoPath, space, onUpdated }) => {
  const navigate = useNavigate();
  const [description, setDescription] = useState(repo.description || '');
  const [isPublic, setIsPublic] = useState(repo.is_public);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setDescription(repo.description || '');
    setIsPublic(repo.is_public);
  }, [repo.id, repo.description, repo.is_public]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setSaving(true);
    try {
      const updated = await api.updateRepo(repoPath, { description, is_public: isPublic });
      onUpdated(updated);
      setSuccess('Repository settings saved.');
    } catch (err: any) {
      setError(err.message || 'Failed to save repository settings.');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (confirmText !== repo.uid) return;
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

  return (
    <div className="max-w-3xl space-y-6">
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

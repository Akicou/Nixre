import React, { useState } from 'react';
import { GitPullRequest, ArrowLeft } from 'lucide-react';
import { api, Branch, PullRequest } from '../lib/api';

interface PullRequestFormProps {
  repoPath: string;
  branches: Branch[];
  defaultBranch: string;
  onCreated: (pr: PullRequest) => void;
  onCancel: () => void;
}

export const PullRequestForm: React.FC<PullRequestFormProps> = ({ repoPath, branches, defaultBranch, onCreated, onCancel }) => {
  const [sourceBranch, setSourceBranch] = useState('');
  const [targetBranch, setTargetBranch] = useState(defaultBranch);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (sourceBranch === targetBranch) {
      setError('Source and target branch must be different.');
      return;
    }
    setLoading(true);
    try {
      const pr = await api.createPullRequest(repoPath, title, description, sourceBranch, targetBranch);
      onCreated(pr);
    } catch (err: any) {
      setError(err.message || 'Failed to create pull request.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-txt-primary flex items-center gap-2">
          <GitPullRequest className="w-4 h-4 text-brand" />
          <span>New Pull Request</span>
        </h3>
        <button onClick={onCancel} className="text-xs text-txt-secondary hover:text-txt-primary flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back</span>
        </button>
      </div>

      {error && (
        <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Source Branch *
            </label>
            <select
              value={sourceBranch}
              onChange={e => setSourceBranch(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
              required
            >
              <option value="" disabled>Select branch</option>
              {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Target Branch *
            </label>
            <select
              value={targetBranch}
              onChange={e => setTargetBranch(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
              required
            >
              {branches.map(b => <option key={b.name} value={b.name}>{b.name}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
            Title *
          </label>
          <input
            type="text"
            placeholder="Short summary of the change"
            value={title}
            onChange={e => setTitle(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
            required
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
            Description
          </label>
          <textarea
            rows={4}
            placeholder="What does this change do, and why?"
            value={description}
            onChange={e => setDescription(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
          />
        </div>

        <div className="pt-2 flex justify-end gap-3 border-t border-border-subtle">
          <button type="button" onClick={onCancel} className="px-4 py-2 rounded text-sm text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition font-medium">
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading || !sourceBranch || !title}
            className="px-4 py-2 rounded bg-brand text-white text-sm font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm"
          >
            {loading ? 'Creating...' : 'Create Pull Request'}
          </button>
        </div>
      </form>
    </div>
  );
};

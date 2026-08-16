import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Layers, ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';

export const NewSpace: React.FC = () => {
  const navigate = useNavigate();
  const [uid, setUid] = useState('');
  const [description, setDescription] = useState('');
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const space = await api.createSpace(uid, description, isPublic);
      navigate(`/${space.uid}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create space');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-10">
      <Link to="/" className="inline-flex items-center gap-1.5 text-xs text-txt-secondary hover:text-txt-primary mb-6 transition">
        <ArrowLeft className="w-4 h-4" />
        <span>Back to Dashboard</span>
      </Link>

      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 sm:p-8 space-y-6">
        <div>
          <h1 className="text-xl font-bold text-txt-primary flex items-center gap-2">
            <Layers className="w-5 h-5 text-brand" />
            <span>Create a new space</span>
          </h1>
          <p className="text-xs text-txt-secondary mt-1">
            Spaces represent organizations or top-level groups that organize related repositories.
          </p>
        </div>

        {error && (
          <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Space Name / UID *
            </label>
            <input
              type="text"
              placeholder="e.g. my-team"
              value={uid}
              onChange={e => setUid(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm font-mono focus:border-brand transition"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-txt-secondary uppercase tracking-wider mb-1.5">
              Description (Optional)
            </label>
            <textarea
              rows={2}
              placeholder="Description of this space"
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-txt-primary text-sm focus:border-brand transition"
            />
          </div>

          <div className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              id="isPublic"
              checked={isPublic}
              onChange={e => setIsPublic(e.target.checked)}
              className="rounded border-border-subtle text-brand focus:ring-0"
            />
            <label htmlFor="isPublic" className="text-xs text-txt-primary font-medium cursor-pointer">
              Public Space
            </label>
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
              {loading ? 'Creating...' : 'Create Space'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

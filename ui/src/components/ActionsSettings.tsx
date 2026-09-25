import React, { useEffect, useState } from 'react';
import { KeyRound, ShieldCheck, Trash2 } from 'lucide-react';
import { api, Repository } from '../lib/api';

// Repository settings for Nixre Actions: branch protection ("require passing
// checks before merging") and encrypted secrets exposed as ${{ secrets.X }}.
export const ActionsSettings: React.FC<{
  repo: Repository;
  repoPath: string;
  onUpdated: (repo: Repository) => void;
}> = ({ repo, repoPath, onUpdated }) => {
  const [secrets, setSecrets] = useState<{ key: string; updated: number }[] | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api
      .listRepoSecrets(repoPath)
      .then(setSecrets)
      .catch(e => setError(e.message || 'Could not load secrets'));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repoPath]);

  const toggleRequired = (next: boolean) => {
    setError('');
    api
      .updateRepo(repoPath, { require_checks: next })
      .then(updated => onUpdated({ ...repo, ...updated, can_write: repo.can_write, starred: repo.starred }))
      .catch(e => setError(e.message || 'Could not update the setting'));
  };

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    const key = name.trim();
    if (!key || !value) return;
    setBusy(true);
    setError('');
    api
      .setRepoSecret(repoPath, key, value)
      .then(() => {
        setName('');
        setValue('');
        return load();
      })
      .catch(err => setError(err.message || 'Could not save the secret'))
      .finally(() => setBusy(false));
  };

  const remove = (key: string) => {
    setError('');
    api
      .deleteRepoSecret(repoPath, key)
      .then(load)
      .catch(err => setError(err.message || 'Could not delete the secret'));
  };

  const field = 'w-full px-3 py-2 rounded-md bg-surface-base border border-border-subtle text-sm text-txt-primary font-mono';

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas p-6 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-txt-primary uppercase tracking-wider">Actions</h2>
        <p className="text-xs text-txt-secondary mt-0.5">
          CI/CD workflows from <code className="font-mono">.nixre/workflows/*.yml</code>. Secrets are encrypted at rest and masked in logs.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-xs text-feedback-error-text">
          {error}
        </p>
      )}

      <label className="flex items-start gap-3 cursor-pointer">
        <input
          type="checkbox"
          className="mt-1"
          checked={Boolean(repo.require_checks)}
          onChange={e => toggleRequired(e.target.checked)}
          aria-label="Require passing checks before merging"
        />
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium text-txt-primary">
            <ShieldCheck className="w-4 h-4 text-txt-tertiary" /> Require passing checks before merging
          </span>
          <span className="block text-xs text-txt-secondary">
            A pull request merges only when every check on its latest commit is green: workflow jobs, or statuses posted by external CI.
          </span>
        </span>
      </label>

      <div className="space-y-3">
        <h3 className="text-xs font-semibold text-txt-secondary uppercase tracking-wider flex items-center gap-1.5">
          <KeyRound className="w-3.5 h-3.5" /> Secrets
        </h3>
        {secrets === null ? (
          <p className="text-xs text-txt-tertiary">Loading...</p>
        ) : secrets.length === 0 ? (
          <p className="text-xs text-txt-tertiary">No secrets yet.</p>
        ) : (
          <ul className="divide-y divide-border-subtle border-y border-border-subtle">
            {secrets.map(s => (
              <li key={s.key} className="flex items-center gap-3 py-2">
                <code className="font-mono text-sm text-txt-primary flex-1 truncate">{s.key}</code>
                <span className="text-[11px] text-txt-tertiary">updated {new Date(s.updated).toLocaleDateString()}</span>
                <button type="button" title={`Delete ${s.key}`} onClick={() => remove(s.key)} className="text-txt-tertiary hover:text-feedback-error-text">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={save} className="grid grid-cols-1 sm:grid-cols-[1fr_2fr_auto] gap-2 items-start">
          <input aria-label="Secret name" placeholder="NAME" className={field} value={name} onChange={e => setName(e.target.value.toUpperCase())} />
          <textarea aria-label="Secret value" placeholder="value" rows={1} className={field} value={value} onChange={e => setValue(e.target.value)} />
          <button
            type="submit"
            disabled={busy || !name.trim() || !value}
            className="px-4 py-2 rounded-md bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50"
          >
            {busy ? 'Saving...' : 'Add or update'}
          </button>
        </form>
        <p className="text-[11px] text-txt-tertiary">
          Use as <code className="font-mono">{'${{ secrets.NAME }}'}</code>. Values cannot be read back, only replaced.
        </p>
      </div>
    </div>
  );
};

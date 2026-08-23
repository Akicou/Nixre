import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  FileText,
  Link2,
  GitCommit,
  Check,
  Plus,
  Loader2,
  X,
  ArrowRight,
} from 'lucide-react';
import { api, UserGoals } from '../lib/api';

const DEFAULT_README = (uid: string) => `# Hi, I'm ${uid}\n\nWelcome to my Nixre profile. ${uid} builds software in the open here.\n\n- 🔭 What I'm working on: a repo below\n- 🌱 Learning: whatever this week throws at me\n\n> Edit this file to make the profile yours.`;

const GOAL_ICONS: Record<string, React.FC<{ className?: string }>> = {
  profile_readme: FileText,
  socials: Link2,
  personal_commit: GitCommit,
  org_commit: GitCommit,
};

export const ProfileGoals: React.FC<{ uid: string; onChanged?: () => void }> = ({ uid, onChanged }) => {
  const [goals, setGoals] = useState<UserGoals | null>(null);
  const [loading, setLoading] = useState(true);
  const [showQuickstart, setShowQuickstart] = useState(false);
  const [readme, setReadme] = useState(DEFAULT_README(uid));
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    api
      .getUserGoals(uid)
      .then(setGoals)
      .catch(() => setGoals({ goals: [] }))
      .finally(() => setLoading(false));

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  const profileGoal = goals?.goals.find(g => g.id === 'profile_readme');

  const createReadme = async () => {
    if (!readme.trim() || creating) return;
    setCreating(true);
    setError('');
    try {
      await api.createRepo(uid, uid, 'Profile README', true, true, 'main', readme);
      setShowQuickstart(false);
      load();
      onChanged?.();
    } catch (err: any) {
      setError(err.message || 'Failed to create profile README.');
    } finally {
      setCreating(false);
    }
  };

  const doneCount = goals?.goals.filter(g => g.done).length ?? 0;

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-brand" />
          <h2 className="text-xs font-semibold text-txt-primary uppercase tracking-wider">Getting started</h2>
        </div>
        {goals && (
          <span className="text-[11px] font-mono text-txt-tertiary">
            {doneCount}/{goals.goals.length} done
          </span>
        )}
      </div>

      <div className="divide-y divide-border-subtle">
        {loading ? (
          <div className="px-4 py-10 flex items-center justify-center gap-2 text-xs text-txt-tertiary">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading goals…
          </div>
        ) : (
          goals?.goals.map(goal => {
            const Icon = GOAL_ICONS[goal.id] ?? Check;
            const pct = Math.min(100, Math.round((goal.current / goal.target) * 100));
            const label =
              goal.id === 'socials' && goal.count !== undefined
                ? `${goal.count}/${goal.target}+`
                : `${goal.current}/${goal.target}`;
            return (
              <div key={goal.id} className="px-4 py-3 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${
                        goal.done ? 'bg-surface-open text-txt-open' : 'bg-surface-subtle text-txt-tertiary'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </span>
                    <span className={`text-[13px] ${goal.done ? 'text-txt-primary font-medium' : 'text-txt-secondary'}`}>
                      {goal.label}
                    </span>
                  </div>
                  <span className="text-[11px] font-mono text-txt-tertiary shrink-0">
                    {goal.done ? '✓' : ''} {label}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex-1 h-1.5 rounded-full bg-surface-subtle overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${goal.done ? 'bg-surface-open' : 'bg-brand/60'}`}
                      style={{ width: `${goal.done ? 100 : pct}%` }}
                    />
                  </div>
                  {goal.id === 'profile_readme' && !goal.done && !showQuickstart && (
                    <button
                      type="button"
                      onClick={() => setShowQuickstart(true)}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium bg-surface-base border border-border-subtle text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
                    >
                      <Plus className="w-3 h-3" />
                      <span>Quickstart</span>
                    </button>
                  )}
                  {goal.id === 'profile_readme' && goal.done && goal.repo?.path && (
                    <Link
                      to={`/${goal.repo.path}`}
                      className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-txt-brand hover:underline"
                    >
                      <span>View</span>
                      <ArrowRight className="w-3 h-3" />
                    </Link>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {showQuickstart && (
        <div className="px-4 py-4 border-t border-border-subtle bg-surface-base/50 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[12.5px] font-semibold text-txt-primary">Create your profile README</p>
              <p className="text-[11px] text-txt-tertiary">
                This creates the repo <span className="font-mono">{uid}/{uid}</span> with a README that renders on your profile.
              </p>
            </div>
            <button
              type="button"
              onClick={() => { setShowQuickstart(false); setError(''); }}
              className="p-1.5 rounded text-txt-tertiary hover:text-txt-primary hover:bg-surface-subtle transition"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <textarea
            value={readme}
            onChange={e => setReadme(e.target.value)}
            rows={8}
            placeholder="# Your profile README…"
            className="w-full px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-[12px] font-mono leading-relaxed focus:border-brand transition resize-y"
          />

          {error && <p className="text-[11px] text-feedback-error-text">{error}</p>}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowQuickstart(false)}
              className="px-3 py-1.5 rounded-md text-xs text-txt-secondary hover:text-txt-primary hover:bg-surface-subtle transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={createReadme}
              disabled={creating || !readme.trim()}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50 transition shadow-sm"
            >
              {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
              <span>{creating ? 'Creating…' : 'Create profile repo'}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

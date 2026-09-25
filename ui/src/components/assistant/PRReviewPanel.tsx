import React, { useEffect, useState } from 'react';
import { PanelRightClose, Bot, Loader2 } from 'lucide-react';
import type { PullRequest } from '../../lib/api';
import { api } from '../../lib/api';
import { decodeBase64Patch } from '../../lib/diff';
import { getActiveProviderProfile, type AssistantProviderProfile } from '../../lib/assistantProfiles';
import { ChatSurface } from './ChatSurface';

interface PRReviewPanelProps {
  repoPath: string;
  pr: PullRequest;
  onClose: () => void;
}

export const PRReviewPanel: React.FC<PRReviewPanelProps> = ({ repoPath, pr, onClose }) => {
  const [profile, setProfile] = useState<AssistantProviderProfile | null>(null);
  // The full PR diff is fetched once and attached to every turn so the
  // assistant reviews what actually changed instead of guessing.
  const [diffContext, setDiffContext] = useState<{ label: string; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getActiveProviderProfile()
      .then(p => {
        if (!cancelled) setProfile(p);
      })
      .catch(() => {});
    // Diff AND commit list are both the `target...source` range resolved against
    // the target's current head, fetched when the panel opens — not cached from
    // when the PR was created. A branch that has been partly merged since then
    // contributes only its remaining commits, so a summary cannot restate work
    // that already landed.
    Promise.all([
      api.getPullRequestDiff(repoPath, pr.number),
      api.getPullRequestCommits(repoPath, pr.number).catch(() => []),
    ])
      .then(([files, commits]) => {
        if (cancelled) return;
        const header = [
          `Pull request #${pr.number} "${pr.title}" merges ${pr.source_branch} into ${pr.target_branch}.`,
          `Everything below is what is NOT yet in ${pr.target_branch}. Commits already merged into`,
          `${pr.target_branch} are deliberately excluded — do not describe them.`,
          '',
          commits.length > 0
            ? `Unmerged commits (${commits.length}, newest first):\n${commits.map(c => `- ${c.title}`).join('\n')}`
            : 'No unmerged commits remain: this branch is already contained in the target.',
          '',
        ].join('\n');
        const text = (header + files
          .map(f => `--- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}) ---\n${decodeBase64Patch(f.patch)}`)
          .join('\n\n'))
          .slice(0, 120_000); // keep inside a sane context budget
        setDiffContext({
          label: `Unmerged changes of PR #${pr.number} "${pr.title}" (${pr.source_branch} → ${pr.target_branch}, vs ${pr.target_branch}'s current head)`,
          text,
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [repoPath, pr.number]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <aside className="fixed top-0 right-0 bottom-0 w-full sm:w-[420px] lg:w-[480px] bg-surface-base border-l border-border-subtle z-50 flex flex-col shadow-2xl">
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-subtle bg-surface-canvas shrink-0">
          <span className="text-xs font-semibold text-txt-primary uppercase tracking-wider flex items-center gap-1.5">
            <PanelRightClose className="w-4 h-4 text-brand" />
            <Bot className="w-4 h-4 text-brand" />
            Nixre Assistant
          </span>
          <button
            onClick={onClose}
            className="p-1.5 rounded hover:bg-surface-subtle text-txt-secondary hover:text-txt-primary transition"
            title="Close (Esc)"
          >
            <PanelRightClose className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {profile ? (
            <ChatSurface
              repoPath={repoPath}
              profile={profile}
              title={`PR #${pr.number} · ${pr.title}`}
              onClose={onClose}
              extraContext={diffContext}
              suggestions={[
                'Review this PR for regressions',
                'Summarize the changes for the PR description',
                'Scan for vulnerabilities',
                'What could break in production?',
              ]}
            />
          ) : (
            <div className="h-full flex items-center justify-center gap-2 text-xs text-txt-tertiary">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading profile…
            </div>
          )}
        </div>
      </aside>
    </>
  );
};

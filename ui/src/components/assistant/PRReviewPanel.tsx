import React, { useEffect, useState } from 'react';
import { PanelRightClose, Bot } from 'lucide-react';
import type { PullRequest } from '../../lib/api';
import { getActiveProviderProfile } from '../../lib/assistantProfiles';
import { ChatSurface } from './ChatSurface';

interface PRReviewPanelProps {
  repoPath: string;
  pr: PullRequest;
  onClose: () => void;
}

export const PRReviewPanel: React.FC<PRReviewPanelProps> = ({ repoPath, pr, onClose }) => {
  const [profile] = useState(() => getActiveProviderProfile());

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
          <ChatSurface
            repoPath={repoPath}
            profile={profile}
            title={`PR #${pr.number} · ${pr.title}`}
            onClose={onClose}
            suggestions={['Review this PR for regressions', 'Run the tests and lint', 'Scan for vulnerabilities', 'Summarize the changes']}
          />
        </div>
      </aside>
    </>
  );
};

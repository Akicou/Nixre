import React, { useState, useEffect } from 'react';
import { ArrowLeft, GitMerge, Plus, Minus, FileDiff as FileDiffIcon, Sparkles } from 'lucide-react';
import { api, PullRequest, FileDiff } from '../lib/api';
import { decodeBase64Patch, parsePatchLines } from '../lib/diff';
import { PRReviewPanel } from './assistant/PRReviewPanel';

interface PullRequestDetailProps {
  repoPath: string;
  prNumber: number;
  onBack: () => void;
}

const lineClass: Record<string, string> = {
  hunk: 'text-txt-brand bg-surface-subtle',
  add: 'text-feedback-success-text bg-feedback-success-bg',
  del: 'text-feedback-error-text bg-feedback-error-bg',
  meta: 'text-txt-tertiary',
  context: 'text-txt-secondary',
};

export const PullRequestDetail: React.FC<PullRequestDetailProps> = ({ repoPath, prNumber, onBack }) => {
  const [pr, setPr] = useState<PullRequest | null>(null);
  const [diff, setDiff] = useState<FileDiff[]>([]);
  const [loading, setLoading] = useState(true);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState('');
  const [copilotOpen, setCopilotOpen] = useState(false);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      api.getPullRequest(repoPath, prNumber),
      api.getPullRequestDiff(repoPath, prNumber),
    ])
      .then(([prRes, diffRes]) => {
        setPr(prRes);
        setDiff(diffRes);
        setLoading(false);
      })
      .catch(err => {
        setError(err.message || 'Failed to load pull request');
        setLoading(false);
      });
  }, [repoPath, prNumber]);

  const handleMerge = async () => {
    setError('');
    setMerging(true);
    try {
      await api.mergePullRequest(repoPath, prNumber, 'merge');
      const updated = await api.getPullRequest(repoPath, prNumber);
      setPr(updated);
    } catch (err: any) {
      setError(err.message || 'Failed to merge pull request.');
    } finally {
      setMerging(false);
    }
  };

  if (loading) {
    return <div className="py-16 text-center text-sm text-txt-tertiary">Loading pull request...</div>;
  }

  if (error && !pr) {
    return (
      <div className="border border-dashed border-border-subtle rounded-lg p-8 text-center text-sm text-txt-secondary">
        {error}
      </div>
    );
  }

  if (!pr) return null;

  return (
    <div className="space-y-4">
      <button onClick={onBack} className="text-xs text-txt-secondary hover:text-txt-primary flex items-center gap-1">
        <ArrowLeft className="w-3.5 h-3.5" />
        <span>Back to Pull Requests</span>
      </button>

      <div className="border border-border-subtle rounded-lg bg-surface-canvas p-5 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold text-txt-primary">
              {pr.title} <span className="text-txt-tertiary font-mono font-normal">#{pr.number}</span>
            </h3>
            <p className="text-xs text-txt-tertiary font-mono mt-1">
              {pr.source_branch} → {pr.target_branch} &bull; by {pr.author?.display_name || pr.author?.uid}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0 flex-wrap">
          <button
            onClick={() => setCopilotOpen(true)}
            className="flex items-center gap-1.5 px-2.5 py-2.5 rounded-md text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm min-h-11"
            title="Review with Nixre Assistant"
          >
            <Sparkles className="w-3.5 h-3.5" />
            Assistant
          </button>
          <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded font-semibold ${
            pr.state === 'open' ? 'bg-surface-open text-txt-open' : pr.state === 'merged' ? 'bg-surface-merged text-txt-merged' : 'bg-surface-closed text-txt-closed'
          }`}>
            {pr.state}
          </span>
          </div>
        </div>

        {pr.description && <p className="text-sm text-txt-secondary whitespace-pre-line">{pr.description}</p>}

        {error && (
          <div className="p-3 rounded bg-feedback-error-bg border border-feedback-error-border text-feedback-error-text text-xs">
            {error}
          </div>
        )}

        {pr.state === 'open' && (
          <button
            onClick={handleMerge}
            disabled={merging}
            className="px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition shadow-sm flex items-center gap-2"
          >
            <GitMerge className="w-4 h-4" />
            <span>{merging ? 'Merging...' : 'Merge Pull Request'}</span>
          </button>
        )}
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider flex items-center gap-1.5">
          <FileDiffIcon className="w-3.5 h-3.5" />
          <span>Changes ({diff.length} file{diff.length === 1 ? '' : 's'})</span>
        </h4>

        {diff.map(file => (
          <div key={file.path} className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
            <div className="p-2.5 bg-surface-base border-b border-border-subtle flex items-center justify-between text-xs font-mono">
              <span className="text-txt-primary font-semibold">{file.path}</span>
              <span className="flex items-center gap-2 text-txt-tertiary">
                <span className="flex items-center gap-0.5 text-feedback-success-text"><Plus className="w-3 h-3" />{file.additions}</span>
                <span className="flex items-center gap-0.5 text-feedback-error-text"><Minus className="w-3 h-3" />{file.deletions}</span>
              </span>
            </div>
            {file.is_binary ? (
              <div className="p-4 text-xs text-txt-tertiary font-mono">Binary file not shown.</div>
            ) : (
              <pre className="overflow-x-auto text-[11px] font-mono leading-relaxed">
                {parsePatchLines(decodeBase64Patch(file.patch)).map((line, i) => (
                  <div key={i} className={`px-3 whitespace-pre ${lineClass[line.type]}`}>{line.content}</div>
                ))}
              </pre>
            )}
          </div>
        ))}
      </div>
      {copilotOpen && <PRReviewPanel repoPath={repoPath} pr={pr} onClose={() => setCopilotOpen(false)} />}
    </div>
  );
};

import React, { useEffect, useState } from 'react';
import { CircleDot, CircleCheck, Plus, ArrowLeft, ShieldAlert } from 'lucide-react';
import { api, Issue, IssueComment } from '../lib/api';
import { Markdown } from './Markdown';

interface Props {
  repoPath: string;
  canWrite: boolean;
  signedIn: boolean;
  selected: number | 'new' | null;
  onSelect: (n: number | 'new' | null) => void;
}

const STATE_CLS = {
  open: 'bg-surface-open text-txt-open',
  closed: 'bg-surface-closed text-txt-closed',
} as const;

function when(ms: number) {
  return new Date(ms).toLocaleString();
}

export const ScanBadge: React.FC = () => (
  <span className="inline-flex items-center gap-1 text-[10px] font-mono uppercase px-1.5 py-0.5 rounded bg-surface-merged text-txt-merged">
    <ShieldAlert className="w-3 h-3" />
    security scan
  </span>
);

const IssueForm: React.FC<{ repoPath: string; onCreated: (i: Issue) => void; onCancel: () => void }> = ({
  repoPath, onCreated, onCancel,
}) => {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onCreated(await api.createIssue(repoPath, title.trim(), body));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create issue');
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 max-w-3xl">
      <h3 className="text-xs font-semibold text-txt-tertiary uppercase tracking-wider">New issue</h3>
      <input
        aria-label="Title"
        value={title}
        onChange={e => setTitle(e.target.value)}
        placeholder="Title"
        className="w-full bg-surface-base border border-border-subtle rounded px-3 py-2 text-sm"
      />
      <textarea
        aria-label="Description"
        value={body}
        onChange={e => setBody(e.target.value)}
        placeholder="Describe the issue (markdown supported)"
        rows={8}
        className="w-full bg-surface-base border border-border-subtle rounded px-3 py-2 text-sm font-mono"
      />
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
        >
          Create issue
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded text-xs text-txt-secondary hover:text-txt-primary">
          Cancel
        </button>
      </div>
    </form>
  );
};

const IssueDetail: React.FC<{ repoPath: string; number: number; canWrite: boolean; signedIn: boolean; onBack: () => void }> = ({
  repoPath, number, canWrite, signedIn, onBack,
}) => {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.getIssue(repoPath, number).then(
      r => { if (live) { setIssue(r.issue); setComments(r.comments); } },
      err => { if (live) setError(err instanceof Error ? err.message : 'Could not load issue'); },
    );
    return () => { live = false; };
  }, [repoPath, number]);

  const toggle = async () => {
    if (!issue) return;
    setBusy(true);
    try {
      setIssue(await api.updateIssue(repoPath, number, { state: issue.state === 'open' ? 'closed' : 'open' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Update failed');
    }
    setBusy(false);
  };

  const comment = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const c = await api.commentOnIssue(repoPath, number, text);
      setComments(prev => [...prev, c]);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Comment failed');
    }
    setBusy(false);
  };

  return (
    <div className="space-y-5 max-w-3xl">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-txt-secondary hover:text-txt-primary">
        <ArrowLeft className="w-3.5 h-3.5" /> All issues
      </button>
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      {!issue ? (
        !error && <p className="text-xs text-txt-tertiary font-mono">Loading…</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <h2 className="text-lg font-semibold text-txt-primary">
                {issue.title} <span className="font-mono text-txt-tertiary">#{issue.number}</span>
              </h2>
              <div className="flex items-center gap-2 text-xs text-txt-tertiary font-mono">
                <span className={`uppercase px-2 py-0.5 rounded font-semibold ${STATE_CLS[issue.state]}`}>{issue.state}</span>
                {issue.source === 'security-scan' && <ScanBadge />}
                <span>{issue.author.display_name || issue.author.uid} · {when(issue.created)}</span>
              </div>
            </div>
            {canWrite && (
              <button
                onClick={toggle}
                disabled={busy}
                className="px-3 py-1.5 rounded text-xs font-medium border border-border-subtle hover:bg-surface-subtle disabled:opacity-50 shrink-0"
              >
                {issue.state === 'open' ? 'Close issue' : 'Reopen issue'}
              </button>
            )}
          </div>
          {issue.labels.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {issue.labels.map(l => (
                <span key={l} className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-surface-subtle text-txt-secondary">{l}</span>
              ))}
            </div>
          )}
          <div className="border-t border-border-subtle pt-4">
            {issue.body ? <Markdown content={issue.body} /> : <p className="text-xs text-txt-tertiary">No description.</p>}
          </div>
          {comments.map(c => (
            <div key={c.id} className="border-t border-border-subtle pt-4 space-y-2">
              <div className="flex items-center gap-2 text-xs text-txt-tertiary font-mono">
                <span className="text-txt-secondary">{c.author.display_name || c.author.uid}</span>
                {c.source === 'security-scan' && <ScanBadge />}
                <span>{when(c.created)}</span>
              </div>
              <Markdown content={c.body} />
            </div>
          ))}
          {signedIn && (
            <form onSubmit={comment} className="border-t border-border-subtle pt-4 space-y-2">
              <textarea
                aria-label="Comment"
                value={text}
                onChange={e => setText(e.target.value)}
                placeholder="Leave a comment"
                rows={4}
                className="w-full bg-surface-base border border-border-subtle rounded px-3 py-2 text-sm"
              />
              <button
                type="submit"
                disabled={busy || !text.trim()}
                className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover disabled:opacity-50"
              >
                Comment
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
};

export const IssuesPanel: React.FC<Props> = ({ repoPath, canWrite, signedIn, selected, onSelect }) => {
  const [filter, setFilter] = useState<'open' | 'closed'>('open');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (selected !== null) return;
    let live = true;
    setIssues(null);
    api.listIssues(repoPath, filter).then(
      r => { if (live) setIssues(r); },
      err => { if (live) setError(err instanceof Error ? err.message : 'Could not load issues'); },
    );
    return () => { live = false; };
  }, [repoPath, filter, selected]);

  if (selected === 'new' && canWrite) {
    return <IssueForm repoPath={repoPath} onCreated={i => onSelect(i.number)} onCancel={() => onSelect(null)} />;
  }
  if (typeof selected === 'number') {
    return (
      <IssueDetail repoPath={repoPath} number={selected} canWrite={canWrite} signedIn={signedIn} onBack={() => onSelect(null)} />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <div className="flex gap-4 text-xs font-semibold uppercase tracking-wider">
          {(['open', 'closed'] as const).map(s => (
            <button
              key={s}
              onClick={() => setFilter(s)}
              aria-pressed={filter === s}
              className={filter === s ? 'text-txt-primary' : 'text-txt-tertiary hover:text-txt-primary'}
            >
              {s}
            </button>
          ))}
        </div>
        {canWrite && (
          <button
            onClick={() => onSelect('new')}
            className="px-3 py-1.5 rounded text-xs font-medium bg-brand text-white hover:bg-brand-hover transition shadow-sm flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>New Issue</span>
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
      <div className="border-y border-border-subtle divide-y divide-border-subtle">
        {issues === null ? (
          !error && <div className="p-8 text-center text-xs text-txt-tertiary font-mono">Loading…</div>
        ) : issues.length === 0 ? (
          <div className="p-12 text-center text-xs text-txt-tertiary font-mono">No {filter} issues.</div>
        ) : (
          issues.map(i => (
            <button
              key={i.number}
              onClick={() => onSelect(i.number)}
              className="w-full py-3 px-1 hover:bg-surface-subtle/50 transition flex items-center justify-between gap-4 text-left"
            >
              <div className="space-y-1 min-w-0">
                <div className="flex items-center gap-2">
                  {i.state === 'open'
                    ? <CircleDot className="w-4 h-4 text-txt-open shrink-0" />
                    : <CircleCheck className="w-4 h-4 text-txt-closed shrink-0" />}
                  <span className="text-sm font-semibold text-txt-primary font-mono">#{i.number}</span>
                  <span className="text-sm font-medium text-txt-primary truncate">{i.title}</span>
                  {i.source === 'security-scan' && <ScanBadge />}
                </div>
                <div className="text-xs text-txt-tertiary font-mono">
                  by {i.author.display_name || i.author.uid}
                  {i.labels.length > 0 && <span> · {i.labels.join(', ')}</span>}
                </div>
              </div>
              <span className="text-[11px] font-mono text-txt-tertiary shrink-0">
                {i.comment_count > 0 ? `${i.comment_count} comments` : ''}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

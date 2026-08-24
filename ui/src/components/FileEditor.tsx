import React, { useState } from 'react';
import { GitBranch, Pencil, Eye, Loader2 } from 'lucide-react';
import { api } from '../lib/api';
import { Markdown, isMarkdownFile } from './Markdown';

interface FileEditorProps {
  repoPath: string;
  branch: string;
  path: string;
  initialContent: string;
  mode: 'edit' | 'create';
  baseSha?: string;
  onCancel: () => void;
  onCommitted: (result: { sha: string; branch: string; path: string }) => void;
}

export const FileEditor: React.FC<FileEditorProps> = ({
  repoPath,
  branch,
  path: initialPath,
  initialContent,
  mode,
  baseSha,
  onCancel,
  onCommitted,
}) => {
  const [filePath, setFilePath] = useState(initialPath);
  const [content, setContent] = useState(initialContent);
  const [tab, setTab] = useState<'edit' | 'preview'>('edit');
  const [message, setMessage] = useState(
    mode === 'create' ? `Create ${initialPath.split('/').pop() || 'file'}` : `Update ${initialPath.split('/').pop() || 'file'}`,
  );
  const [target, setTarget] = useState<'current' | 'new'>('current');
  const [newBranch, setNewBranch] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const name = filePath.split('/').pop() || '';
  const canPreview = isMarkdownFile(name);

  const handleCommit = async (e: React.FormEvent) => {
    e.preventDefault();
    const dest = filePath.replace(/^\/+/, '').trim();
    if (!dest) {
      setError('Enter a file path.');
      return;
    }
    if (!message.trim()) {
      setError('Enter a commit message.');
      return;
    }
    if (target === 'new' && !newBranch.trim()) {
      setError('Enter a new branch name.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await api.commitFiles(repoPath, {
        branch,
        new_branch: target === 'new' ? newBranch.trim() : undefined,
        message: message.trim(),
        files: [{ path: dest, content, action: mode === 'create' ? 'create' : 'update' }],
        base_sha: baseSha,
      });
      onCommitted({ ...result, path: dest });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Commit failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="border border-border-subtle rounded-lg bg-surface-canvas overflow-hidden">
      <div className="p-3 bg-surface-base border-b border-border-subtle flex items-center gap-2 text-xs font-mono min-w-0">
        {mode === 'create' ? (
          <input
            value={filePath}
            onChange={e => setFilePath(e.target.value)}
            placeholder="path/to/file.txt"
            className="flex-1 min-w-0 px-2 py-1.5 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary outline-none focus:border-brand"
            aria-label="File path"
          />
        ) : (
          <span className="truncate text-txt-primary font-semibold">{filePath}</span>
        )}
        {canPreview && (
          <div className="flex items-center rounded border border-border-subtle bg-surface-canvas p-0.5 shrink-0 ml-auto">
            <button
              type="button"
              onClick={() => setTab('edit')}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${
                tab === 'edit' ? 'bg-brand text-white' : 'text-txt-secondary hover:text-txt-primary'
              }`}
            >
              <Pencil className="w-3 h-3" />
              Edit
            </button>
            <button
              type="button"
              onClick={() => setTab('preview')}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] ${
                tab === 'preview' ? 'bg-brand text-white' : 'text-txt-secondary hover:text-txt-primary'
              }`}
            >
              <Eye className="w-3 h-3" />
              Preview
            </button>
          </div>
        )}
      </div>

      {tab === 'preview' && canPreview ? (
        <div className="p-6 min-h-[16rem]">
          <Markdown content={content} />
        </div>
      ) : (
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          spellCheck={false}
          className="file-editor-textarea w-full min-h-[24rem] p-4 font-mono text-xs leading-relaxed outline-none resize-y"
          aria-label="File contents"
        />
      )}

      <form onSubmit={handleCommit} className="border-t border-border-subtle bg-surface-base p-4 space-y-4">
        <div>
          <label className="block text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            Commit message
          </label>
          <input
            value={message}
            onChange={e => setMessage(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs font-mono outline-none focus:border-brand"
            required
          />
        </div>

        <fieldset className="space-y-2">
          <legend className="text-[11px] font-semibold text-txt-tertiary uppercase tracking-wider mb-1.5">
            Commit to
          </legend>
          <label className="flex items-center gap-2 text-xs text-txt-primary cursor-pointer">
            <input
              type="radio"
              name="commit-target"
              className="accent-brand"
              checked={target === 'current'}
              onChange={() => setTarget('current')}
            />
            <GitBranch className="w-3.5 h-3.5 text-txt-tertiary" />
            <span>Commit directly to <span className="font-mono font-semibold">{branch}</span></span>
          </label>
          <label className="flex items-start gap-2 text-xs text-txt-primary cursor-pointer">
            <input
              type="radio"
              name="commit-target"
              className="mt-2 accent-brand"
              checked={target === 'new'}
              onChange={() => setTarget('new')}
            />
            <div className="flex-1 min-w-0 space-y-1.5">
              <span>Commit to a new branch</span>
              {target === 'new' && (
                <input
                  value={newBranch}
                  onChange={e => setNewBranch(e.target.value)}
                  placeholder="feature/edit"
                  className="w-full px-3 py-1.5 rounded-md bg-surface-canvas border border-border-subtle text-txt-primary text-xs font-mono outline-none focus:border-brand"
                  aria-label="New branch name"
                />
              )}
            </div>
          </label>
        </fieldset>

        {error && (
          <p className="text-xs text-feedback-error-text bg-feedback-error-bg border border-feedback-error-border rounded p-2">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-brand text-white text-xs font-medium hover:bg-brand-hover disabled:opacity-50 transition"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Commit changes
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 rounded border border-border-subtle text-txt-secondary text-xs hover:text-txt-primary hover:bg-surface-subtle transition"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
};

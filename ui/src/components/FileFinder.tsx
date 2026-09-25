import React, { useEffect, useMemo, useRef, useState } from 'react';
import { File, Search } from 'lucide-react';
import { api } from '../lib/api';

/**
 * Fuzzy score of `query` against `path` (higher is better), or null when the
 * query is not a subsequence. Rewards consecutive runs, matches at the start
 * of a path segment or word, and matches in the file name; shorter paths win
 * ties.
 */
export function fuzzyScore(query: string, path: string): { score: number; hits: number[] } | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (!q) return { score: 0, hits: [] };
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf('/') + 1;
  const hits: number[] = [];
  let score = 0;
  let pi = 0;
  let prev = -2;
  for (const ch of q) {
    const found = p.indexOf(ch, pi);
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 5;
    const before = p[found - 1];
    if (found === 0 || before === '/' || before === '-' || before === '_' || before === '.') s += 4;
    if (found >= nameStart) s += 2;
    score += s;
    hits.push(found);
    prev = found;
    pi = found + 1;
  }
  return { score: score - path.length * 0.05, hits };
}

function Highlighted({ text, hits }: { text: string; hits: number[] }) {
  const set = new Set(hits);
  return (
    <>
      {[...text].map((c, i) =>
        set.has(i) ? (
          <mark key={i} className="bg-transparent text-brand font-semibold">
            {c}
          </mark>
        ) : (
          <React.Fragment key={i}>{c}</React.Fragment>
        ),
      )}
    </>
  );
}

export const FileFinder: React.FC<{
  repoPath: string;
  gitRef: string;
  onPick: (path: string) => void;
  onClose: () => void;
}> = ({ repoPath, gitRef, onPick, onClose }) => {
  const [files, setFiles] = useState<string[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .listFiles(repoPath, gitRef)
      .then(r => {
        if (!alive) return;
        setFiles(r.files);
        setTruncated(r.truncated);
      })
      .catch(e => alive && setError(e.message || 'Could not list files'));
    input.current?.focus();
    return () => {
      alive = false;
    };
  }, [repoPath, gitRef]);

  const results = useMemo(() => {
    if (!files) return [];
    const scored: { path: string; score: number; hits: number[] }[] = [];
    for (const path of files) {
      const r = fuzzyScore(query, path);
      if (r) scored.push({ path, ...r });
    }
    if (query) scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 50);
  }, [files, query]);

  useEffect(() => setActive(0), [query]);

  const pick = (path: string | undefined) => {
    if (path) onPick(path);
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 flex items-start justify-center pt-[12vh] px-4"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Go to file" className="w-full max-w-2xl rounded-lg bg-surface-canvas border border-border-mid shadow-2xl overflow-hidden">
        <div className="flex items-center gap-2 px-3 border-b border-border-subtle">
          <Search className="w-4 h-4 text-txt-tertiary shrink-0" />
          <input
            ref={input}
            aria-label="Find a file"
            placeholder={`Find a file in ${repoPath} at ${gitRef}...`}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActive(a => Math.min(a + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActive(a => Math.max(a - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                pick(results[active]?.path);
              }
            }}
            className="w-full py-3 bg-transparent text-sm text-txt-primary placeholder:text-txt-tertiary outline-none"
          />
          <kbd className="text-[10px] font-mono text-txt-tertiary border border-border-subtle rounded px-1">Esc</kbd>
        </div>
        <ul role="listbox" aria-label="Files" className="max-h-[50vh] overflow-y-auto py-1">
          {error ? (
            <li className="px-4 py-6 text-sm text-feedback-error-text">{error}</li>
          ) : files === null ? (
            <li className="px-4 py-6 text-sm text-txt-tertiary">Loading files...</li>
          ) : results.length === 0 ? (
            <li className="px-4 py-6 text-sm text-txt-tertiary">No matching files</li>
          ) : (
            results.map((r, i) => (
              <li key={r.path} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(r.path)}
                  className={`w-full text-left px-4 py-1.5 flex items-center gap-2 text-sm font-mono ${i === active ? 'bg-surface-subtle text-txt-primary' : 'text-txt-secondary'}`}
                >
                  <File className="w-3.5 h-3.5 shrink-0 text-txt-tertiary" />
                  <span className="truncate">
                    <Highlighted text={r.path} hits={r.hits} />
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="px-4 py-2 border-t border-border-subtle text-[11px] text-txt-tertiary flex justify-between">
          <span>↑↓ to move · Enter to open · press t anywhere in a repo to open this</span>
          {truncated && <span>Showing the first 50,000 files</span>}
        </div>
      </div>
    </div>
  );
};

/** True when a key event should not trigger a page shortcut (typing in a field). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

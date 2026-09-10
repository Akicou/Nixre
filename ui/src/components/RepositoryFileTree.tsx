import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, File, Folder, FolderOpen, History, Loader2 } from 'lucide-react';
import type { TreeEntry } from '../lib/api';
import type { TreeLoader } from '../lib/repositoryTree';

interface Props {
  loadEntries: TreeLoader;
  selectedPath: string;
  selectedType: 'tree' | 'blob';
  onSelect: (path: string, type: 'tree' | 'blob') => void;
  onHistory: (path: string) => void;
}
interface Directory { entries?: TreeEntry[]; error?: string; loading?: boolean }

export function RepositoryFileTree({ loadEntries, selectedPath, selectedType, onSelect, onHistory }: Props) {
  const [directories, setDirectories] = useState<Record<string, Directory>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState('');
  const alive = useRef(true);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const inflight = useRef(new Set<string>());
  const load = useCallback(async (path: string) => {
    if (inflight.current.has(path)) return;
    inflight.current.add(path);
    setDirectories(prev => ({ ...prev, [path]: { ...prev[path], loading: true, error: undefined } }));
    try {
      const entries = await loadEntries(path);
      if (alive.current) setDirectories(prev => ({ ...prev, [path]: { entries } }));
    } catch (error) {
      if (alive.current) setDirectories(prev => ({ ...prev, [path]: { error: (error as Error).message || 'Could not load this folder.' } }));
    } finally { inflight.current.delete(path); }
  }, [loadEntries]);
  useEffect(() => {
    alive.current = true;
    void load('');
    return () => { alive.current = false; };
  }, [load]);
  useEffect(() => {
    const segments = selectedPath.split('/').filter(Boolean);
    if (selectedType === 'blob') segments.pop();
    const parents = segments.map((_, i) => segments.slice(0, i + 1).join('/'));
    setExpanded(prev => new Set([...prev, ...parents]));
    parents.forEach(path => void load(path));
  }, [selectedPath, selectedType, load]);

  const visible: { entry: TreeEntry; path: string; parent: string; level: number }[] = [];
  const visit = (parent: string, level: number) => {
    const entries = [...(directories[parent]?.entries || [])].sort((a, b) =>
      (a.type === b.type ? 0 : a.type === 'tree' ? -1 : 1) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = parent ? `${parent}/${entry.name}` : entry.name;
      visible.push({ entry, path, parent, level });
      if (entry.type === 'tree' && expanded.has(path)) visit(path, level + 1);
    }
  };
  visit('', 1);
  const focus = (path: string) => { setFocused(path); buttons.current.get(path)?.focus(); };
  const expand = (path: string) => {
    setExpanded(prev => new Set([...prev, path]));
    if (!directories[path]?.entries) void load(path);
  };
  const collapse = (path: string) => setExpanded(prev => { const next = new Set(prev); next.delete(path); return next; });
  const root = directories[''];
  const retry = (path: string) => <button type="button" onClick={() => void load(path)} className="underline text-brand">Retry {path || 'files'}</button>;

  return <div className="min-w-0">
    {root?.loading && !root.entries && <p role="status" className="py-4 text-xs text-txt-tertiary">Loading files…</p>}
    {root?.error && <p role="alert" className="py-4 text-xs text-feedback-error-text">{root.error} {retry('')}</p>}
    {root?.entries?.length === 0 && <p className="py-6 text-sm text-txt-tertiary">This repository is empty.</p>}
    <ul role="tree" aria-label="Repository files" className="max-h-[26rem] lg:max-h-[36rem] overflow-auto py-1">
      {visible.map(({ entry, path, parent, level }, index) => {
        const isFolder = entry.type === 'tree', isOpen = expanded.has(path);
        const directory = directories[path];
        return <li key={path} role="none">
          <div className="flex items-center group min-w-0">
            <button
              ref={element => { if (element) buttons.current.set(path, element); else buttons.current.delete(path); }}
              type="button" role="treeitem" aria-label={entry.name} aria-level={level}
              aria-expanded={isFolder ? isOpen : undefined} aria-selected={selectedPath === path}
              tabIndex={focused === path || (!buttons.current.has(focused) && index === 0) ? 0 : -1}
              onFocus={() => setFocused(path)}
              onClick={() => {
                if (isFolder && isOpen) { collapse(path); return; }
                if (isFolder) expand(path);
                onSelect(path, entry.type);
              }}
              onKeyDown={event => {
                if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) event.preventDefault();
                if (event.key === 'ArrowDown') focus(visible[Math.min(index + 1, visible.length - 1)].path);
                if (event.key === 'ArrowUp') focus(visible[Math.max(index - 1, 0)].path);
                if (event.key === 'Home') focus(visible[0].path);
                if (event.key === 'End') focus(visible[visible.length - 1].path);
                if (event.key === 'ArrowRight' && isFolder) {
                  if (!isOpen) expand(path);
                  else if (visible[index + 1]?.parent === path) focus(visible[index + 1].path);
                }
                if (event.key === 'ArrowLeft') { if (isFolder && isOpen) collapse(path); else if (parent) focus(parent); }
              }}
              style={{ paddingLeft: `${(level - 1) * 16 + 8}px` }}
              className={`flex items-center gap-2 min-w-0 flex-1 py-2 pr-2 rounded text-left text-xs font-mono focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand ${selectedPath === path ? 'bg-brand/10 text-brand' : 'text-txt-secondary hover:bg-surface-subtle'}`}
            >
              {isFolder ? <ChevronRight className={`w-3 h-3 shrink-0 transition-transform ${isOpen ? 'rotate-90' : ''}`} /> : <span className="w-3 shrink-0" />}
              {isFolder ? (isOpen ? <FolderOpen className="w-4 h-4 shrink-0 text-brand" /> : <Folder className="w-4 h-4 shrink-0 text-brand" />) : <File className="w-4 h-4 shrink-0 text-txt-tertiary" />}
              <span className="truncate">{entry.name}</span>
              {directory?.loading && <Loader2 className="w-3 h-3 animate-spin shrink-0 ml-auto" />}
            </button>
            <button type="button" onClick={() => onHistory(path)} title={`History of ${path}`} aria-label={`History of ${path}`} className="p-2 text-txt-tertiary hover:text-brand opacity-0 group-hover:opacity-100 focus:opacity-100"><History className="w-3 h-3" /></button>
          </div>
          {isOpen && directory?.error && <p role="alert" className="pl-8 py-2 text-xs text-feedback-error-text">{directory.error} {retry(path)}</p>}
          {isOpen && directory?.entries?.length === 0 && <p className="pl-8 py-2 text-xs text-txt-tertiary">Empty folder</p>}
        </li>;
      })}
    </ul>
  </div>;
}

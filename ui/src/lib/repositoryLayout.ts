import { useEffect, useRef, useState } from 'react';
import { getAllPrefs, putPref } from './syncApi';

export const REPOSITORY_LAYOUTS = [
  { id: 'split', label: 'Split view', description: 'Files and deployments side by side; preview below.' },
  { id: 'columns', label: 'Three columns', description: 'File tree, preview, and deployments side by side. Scroll the workspace horizontally on smaller screens.' },
  { id: 'preview-left', label: 'Preview left', description: 'Large file preview on the left, with files and deployments on the right.' },
  { id: 'stacked', label: 'Stacked', description: 'Full-width files, preview, and deployments arranged vertically.' },
] as const;
export type RepositoryLayout = typeof REPOSITORY_LAYOUTS[number]['id'];
export const REPOSITORY_LAYOUT_KEY = 'repository_layout';
export function parseRepositoryLayout(value: unknown): RepositoryLayout {
  return REPOSITORY_LAYOUTS.find(layout => layout.id === value)?.id ?? 'split';
}

/** Account-scoped, like the other UI preferences; guest choices last this visit. */
export function useRepositoryLayout(userId?: string) {
  const [layout, setLayout] = useState<RepositoryLayout>('split');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const revision = useRef(0);
  const writes = useRef(Promise.resolve());
  useEffect(() => {
    const version = ++revision.current;
    let alive = true;
    setLayout('split'); setError(''); setSaving(false);
    if (userId) {
      getAllPrefs().then(prefs => {
        if (alive && revision.current === version) setLayout(parseRepositoryLayout(prefs[REPOSITORY_LAYOUT_KEY]));
      }).catch(() => {
        if (alive && revision.current === version) setError('Could not load your layout preference.');
      });
    }
    return () => { alive = false; revision.current++; };
  }, [userId]);

  const chooseLayout = (value: RepositoryLayout) => {
    const version = ++revision.current;
    setLayout(value); setError('');
    if (!userId) return;
    setSaving(true);
    // Serialize rapid changes so the last selected layout is also the last saved.
    const write = writes.current.catch(() => {}).then(() => putPref(REPOSITORY_LAYOUT_KEY, value));
    writes.current = write;
    void write.catch(() => {
      if (revision.current === version) setError('Layout changed here, but could not be saved. Choose it again to retry.');
    }).finally(() => { if (revision.current === version) setSaving(false); });
  };
  return { layout, chooseLayout, error, saving };
}

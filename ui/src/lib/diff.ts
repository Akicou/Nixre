export type DiffLineType = 'hunk' | 'add' | 'del' | 'context' | 'meta';

export interface DiffLine {
  type: DiffLineType;
  content: string;
}

// Gitness marshals the FileDiff.Patch []byte field as a base64 JSON string.
export function decodeBase64Patch(patch: string | undefined): string {
  if (!patch) return '';
  return atob(patch);
}

export function parsePatchLines(patchText: string): DiffLine[] {
  if (!patchText) return [];

  return patchText.split('\n').filter((_, i, arr) => {
    // drop the single trailing empty line produced by a trailing '\n'
    return !(i === arr.length - 1 && arr[i] === '');
  }).map(line => {
    if (line.startsWith('@@')) return { type: 'hunk' as const, content: line };
    if (line.startsWith('+++') || line.startsWith('---')) return { type: 'meta' as const, content: line };
    if (line.startsWith('+')) return { type: 'add' as const, content: line };
    if (line.startsWith('-')) return { type: 'del' as const, content: line };
    return { type: 'context' as const, content: line };
  });
}

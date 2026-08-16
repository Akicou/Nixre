import { describe, it, expect } from 'vitest';
import { decodeBase64Patch, parsePatchLines } from './diff';

describe('decodeBase64Patch', () => {
  it('decodes a base64 patch string (Gitness marshals []byte patch fields as base64 JSON)', () => {
    const text = '@@ -1,1 +1,1 @@\n-old\n+new\n';
    const b64 = btoa(text);
    expect(decodeBase64Patch(b64)).toBe(text);
  });

  it('returns an empty string for an undefined patch (binary files, is_binary=true)', () => {
    expect(decodeBase64Patch(undefined)).toBe('');
  });
});

describe('parsePatchLines', () => {
  it('classifies hunk headers, additions, deletions, and context lines', () => {
    const patch = [
      '@@ -1,3 +1,4 @@',
      ' line1',
      '-line2',
      '+line2 modified',
      '+line3 new',
      ' line4',
    ].join('\n');

    const lines = parsePatchLines(patch);

    expect(lines).toEqual([
      { type: 'hunk', content: '@@ -1,3 +1,4 @@' },
      { type: 'context', content: ' line1' },
      { type: 'del', content: '-line2' },
      { type: 'add', content: '+line2 modified' },
      { type: 'add', content: '+line3 new' },
      { type: 'context', content: ' line4' },
    ]);
  });

  it('does not misclassify the +++ / --- file header lines as add/del', () => {
    const patch = [
      '--- a/file.txt',
      '+++ b/file.txt',
      '@@ -1,1 +1,1 @@',
      '-old',
      '+new',
    ].join('\n');

    const lines = parsePatchLines(patch);

    expect(lines[0]).toEqual({ type: 'meta', content: '--- a/file.txt' });
    expect(lines[1]).toEqual({ type: 'meta', content: '+++ b/file.txt' });
  });

  it('returns an empty array for empty input', () => {
    expect(parsePatchLines('')).toEqual([]);
  });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

describe('api.getPullRequestDiff', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('requests include_patch=true and returns the FileDiff array', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: () => Promise.resolve([
        { sha: 'abc', path: 'a.txt', status: 'MODIFIED', additions: 1, deletions: 1, changes: 2, patch: btoa('@@ -1 +1 @@\n-a\n+b\n'), is_binary: false, is_submodule: false },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await api.getPullRequestDiff('space/repo', 3);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/repos/space/repo/+/pullreq/3/diff?include_patch=true'),
      expect.any(Object)
    );
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('a.txt');
  });
});

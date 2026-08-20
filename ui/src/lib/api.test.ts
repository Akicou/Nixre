import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

describe('api.getRawBlob', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('throws when the response is not ok instead of returning the error body as file content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve('{"message":"file not found"}'),
    }));

    await expect(api.getRawBlob('space/repo', 'main', 'missing.txt')).rejects.toThrow(/file not found/i);
  });

  it('returns the blob content when the response is ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('hello world'),
    }));

    const blob = await api.getRawBlob('space/repo', 'main', 'hello.txt');
    expect(blob.content).toBe('hello world');
    expect(blob.name).toBe('hello.txt');
  });
});

describe('api.getTree', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('reads the entries array at the top level of the Gitness content response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        path: '.',
        type: 'tree',
        entries: [
          { path: 'README.md', name: 'README.md', type: 'blob', mode: 33188, sha: 'abc', size: 1 },
          { path: 'ui', name: 'ui', type: 'tree', mode: 168777, sha: 'def', size: 0 },
        ],
      }),
    }));

    const res = await api.getTree('space/repo', 'main', '');
    expect(res.entries).toHaveLength(2);
    expect(res.entries.map(e => e.name)).toEqual(['README.md', 'ui']);
  });

  it('returns an empty list when the response has no entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ path: '.', type: 'tree' }),
    }));

    const res = await api.getTree('space/repo', 'main', '');
    expect(res.entries).toEqual([]);
  });
});

describe('api.updateRepo / api.deleteRepo', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('PATCHes the repository settings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ id: 100, uid: 'website', is_public: false }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.updateRepo('space/repo', { description: 'desc', is_public: false });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/space/repo/+');
    expect(options.method).toBe('PATCH');
    expect(JSON.parse(options.body)).toEqual({ description: 'desc', is_public: false });
  });

  it('DELETEs the repository', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      headers: new Headers({}),
      json: () => Promise.resolve({}),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.deleteRepo('space/repo');

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/space/repo/+');
    expect(options.method).toBe('DELETE');
  });
});

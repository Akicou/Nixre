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

  it('reads entries nested under content.entries and maps dir/file to tree/blob', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({
        type: 'dir',
        sha: 'f0f8',
        name: '',
        path: '',
        content: {
          entries: [
            { type: 'file', sha: 'abc', name: 'README.md', path: 'README.md' },
            { type: 'dir', sha: 'def', name: 'ui', path: 'ui' },
          ],
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await api.getTree('space/repo', 'main', '');

    expect(res.entries).toHaveLength(2);
    expect(res.entries.map(e => e.name)).toEqual(['README.md', 'ui']);
    expect(res.entries.map(e => e.type)).toEqual(['blob', 'tree']);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/space/repo/+/content?git_ref=main');
  });

  it('puts the path in the URL segment and the git ref in the query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ type: 'dir', content: { entries: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.getTree('space/repo', 'feature/x', 'backend/src');

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/space/repo/+/content/backend/src?git_ref=feature%2Fx');
  });

  it('returns an empty list when the response has no entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ type: 'dir' }),
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

  it('POSTs a repository transfer', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ uid: 'site', path: 'jane/site' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await api.transferRepo('acme/website', { space: 'jane', uid: 'site' });

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/v1/repos/acme/website/+/transfer');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ space: 'jane', uid: 'site' });
  });
});

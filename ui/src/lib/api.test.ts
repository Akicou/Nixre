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

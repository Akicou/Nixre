import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

describe('api storage keys (branding: Nixre, not the old AetherForge name)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('stores the session token under nixre_token, not aether_token', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ access_token: 'tok123' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: () => Promise.resolve({ id: 1, uid: 'me', email: 'me@nixre.dev', display_name: 'Me', admin: false }),
      }));

    await api.login('me', 'pw');

    expect(localStorage.getItem('nixre_token')).toBe('tok123');
    expect(localStorage.getItem('aether_token')).toBeNull();
  });
});

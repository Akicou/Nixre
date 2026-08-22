import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebAuthnService } from './webauthn';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

installSyncFetchMock();

describe('WebAuthnService', () => {
  beforeEach(() => {
    localStorage.clear();
    syncMockReset();
    vi.stubGlobal('navigator', {
      credentials: {
        create: vi.fn(),
        get: vi.fn().mockResolvedValue({
          rawId: new Uint8Array([1, 2, 3]).buffer,
        }),
      },
    });
    vi.stubGlobal('window', globalThis.window ?? {});
    Object.defineProperty(window, 'crypto', {
      value: { getRandomValues: (arr: Uint8Array) => arr },
      configurable: true,
    });
  });

  it('authenticatePasskey throws instead of fabricating a fake identity when no passkeys are registered', async () => {
    await expect(WebAuthnService.authenticatePasskey()).rejects.toThrow(/no passkeys/i);
  });

  it('loginWithPasskey surfaces the challenge error when the user has no registered keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ message: "No passkeys registered for 'x' on localhost." }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(WebAuthnService.loginWithPasskey('x')).rejects.toThrow(/no passkeys registered/i);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/webauthn/login-challenge',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

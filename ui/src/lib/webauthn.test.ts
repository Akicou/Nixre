import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebAuthnService } from './webauthn';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

installSyncFetchMock();

describe('WebAuthnService.authenticatePasskey', () => {
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

  it('throws instead of fabricating a fake identity when no passkeys are registered', async () => {
    await expect(WebAuthnService.authenticatePasskey()).rejects.toThrow(/no passkeys/i);
  });
});

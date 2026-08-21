// WebAuthn / Passkeys implementation for Nixre.
//
// The WebAuthn ceremony (navigator.credentials) runs in the browser, but the
// vault listing - which credentials this account has registered - is stored
// server-side via nixre-sync, so passkeys follow the account across browsers
// and devices. Note: a passkey is bound to the hostname it was created for
// (rp.id), so a credential registered on `localhost` cannot authenticate on
// `127.0.0.1` - use a canonical origin.

import * as sync from './syncApi';

export type StoredPasskey = sync.SyncPasskey;

export class WebAuthnService {
  // Check if WebAuthn is supported in current browser
  static isSupported(): boolean {
    return (
      typeof window !== 'undefined' &&
      !!window.navigator &&
      !!window.navigator.credentials &&
      typeof window.navigator.credentials.create === 'function' &&
      typeof window.navigator.credentials.get === 'function'
    );
  }

  // Get list of registered passkeys
  static async getRegisteredPasskeys(userUid?: string): Promise<StoredPasskey[]> {
    const keys = await sync.listPasskeys();
    if (userUid) {
      return keys.filter(k => k.userUid.toLowerCase() === userUid.toLowerCase());
    }
    return keys;
  }

  // Register a new passkey
  static async registerPasskey(user: { uid: string; email: string; display_name: string }, keyName?: string): Promise<StoredPasskey> {
    if (!this.isSupported()) {
      throw new Error('WebAuthn / Passkeys are not supported on this browser or connection (requires HTTPS or localhost).');
    }

    const randomChallenge = new Uint8Array(32);
    window.crypto.getRandomValues(randomChallenge);

    const encoder = new TextEncoder();
    const userIdBuffer = encoder.encode(user.uid);

    const rpName = 'Nixre';
    const rpId = window.location.hostname;

    const createOptions: CredentialCreationOptions = {
      publicKey: {
        challenge: randomChallenge,
        rp: {
          name: rpName,
          id: rpId,
        },
        user: {
          id: userIdBuffer,
          name: user.email || user.uid,
          displayName: user.display_name || user.uid,
        },
        pubKeyCredParams: [
          { alg: -7, type: 'public-key' }, // ES256 (P-256 with SHA-256)
          { alg: -257, type: 'public-key' }, // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: undefined, // Allows both platform (TouchID/FaceID) and cross-platform (YubiKey)
          userVerification: 'preferred',
          residentKey: 'preferred',
        },
        timeout: 60000,
        attestation: 'none',
      },
    };

    const credential = (await navigator.credentials.create(createOptions)) as PublicKeyCredential;
    if (!credential) {
      throw new Error('Failed to create passkey credential.');
    }

    // Convert rawId to base64url
    const rawIdBase64 = this.bufferToBase64URL(credential.rawId);

    // Persist the credential metadata in the server-side vault.
    return sync.createPasskey({
      id: rawIdBase64,
      name: keyName || `Passkey (${new Date().toLocaleDateString()})`,
      userUid: user.uid,
      userEmail: user.email || '',
    });
  }

  // Authenticate with a passkey
  static async authenticatePasskey(userUid?: string): Promise<{ passkey: StoredPasskey }> {
    if (!this.isSupported()) {
      throw new Error('WebAuthn is not supported on this device.');
    }

    const keys = await this.getRegisteredPasskeys(userUid);
    if (keys.length === 0 && userUid) {
      throw new Error(`No passkeys registered for user '${userUid}'. Please add one in Settings first.`);
    }

    const randomChallenge = new Uint8Array(32);
    window.crypto.getRandomValues(randomChallenge);

    const allowCredentials = keys.map(k => ({
      id: this.base64URLToBuffer(k.id),
      type: 'public-key' as const,
    }));

    const getOptions: CredentialRequestOptions = {
      publicKey: {
        challenge: randomChallenge,
        rpId: window.location.hostname,
        allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
        userVerification: 'preferred',
        timeout: 60000,
      },
    };

    const assertion = (await navigator.credentials.get(getOptions)) as PublicKeyCredential;
    if (!assertion) {
      throw new Error('Authentication aborted.');
    }

    const assertionId = this.bufferToBase64URL(assertion.rawId);
    const matchedKey = keys.find(k => k.id === assertionId) || keys[0];
    if (!matchedKey) {
      throw new Error('No passkeys registered on this device. Please add one in Settings first.');
    }

    const touched = await sync.touchPasskey(matchedKey.id);
    return { passkey: touched };
  }

  // Delete a passkey
  static async deletePasskey(id: string): Promise<void> {
    await sync.deletePasskey(id);
  }

  private static bufferToBase64URL(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  private static base64URLToBuffer(base64url: string): ArrayBuffer {
    let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
      base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

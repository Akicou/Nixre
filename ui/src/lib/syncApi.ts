// Typed client for the nixre-sync backend (account-scoped persistence).
//
// All Nixre UI state that belongs to a user account — plugin toggles and
// configs, assistant profiles, chat sessions, the passkey vault — is stored
// server-side in Postgres via this service. The UI keeps no local copy
// (server-only source of truth); the session token itself still lives in
// localStorage because it is browser session state, not account data.
//
// A one-time migration (migrateLegacyLocalStorage) uploads any data written
// by the old localStorage-based implementation on first login, then removes
// it so it cannot silently shadow the server.

const BASE = '/api/sync/v1';

export interface SyncConversation {
  id: string;
  repoPath: string;
  title: string;
  messages: unknown[];
  updatedAt: number;
}

export interface SyncPasskey {
  id: string;
  name: string;
  userUid: string;
  userEmail: string;
  publicKey?: string | null;
  createdAt: number;
  lastUsedAt?: number;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('nixre_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers || {}) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {}
    const err = new Error(msg) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  const contentType = res.headers.get('content-type') || '';
  return (contentType.includes('application/json') ? res.json() : {}) as T;
}

// --- prefs --------------------------------------------------------------------

export function getAllPrefs(): Promise<Record<string, unknown>> {
  return request<Record<string, unknown>>('/prefs');
}

export function putPref(key: string, value: unknown): Promise<void> {
  return request(`/prefs/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
}

export function deletePref(key: string): Promise<void> {
  return request(`/prefs/${encodeURIComponent(key)}`, { method: 'DELETE' });
}

// --- conversations -------------------------------------------------------------

export function listConversations(repoPath?: string): Promise<SyncConversation[]> {
  const q = repoPath ? `?repo=${encodeURIComponent(repoPath)}` : '';
  return request<SyncConversation[]>(`/conversations${q}`);
}

export function getConversation(id: string): Promise<SyncConversation | null> {
  return request<SyncConversation>(`/conversations/${encodeURIComponent(id)}`).catch(err => {
    if (err?.status === 404) return null;
    throw err;
  });
}

export function createConversation(
  repoPath: string,
  title: string,
  messages: unknown[] = [],
): Promise<SyncConversation> {
  return request<SyncConversation>('/conversations', {
    method: 'POST',
    body: JSON.stringify({ repoPath, title, messages }),
  });
}

export function updateConversation(
  id: string,
  patch: { title?: string; messages?: unknown[] },
): Promise<SyncConversation> {
  return request<SyncConversation>(`/conversations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function deleteConversation(id: string): Promise<void> {
  return request(`/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- passkeys --------------------------------------------------------------------

export function listPasskeys(): Promise<SyncPasskey[]> {
  return request<SyncPasskey[]>('/passkeys');
}

export function createPasskey(key: {
  id: string;
  name: string;
  userUid: string;
  userEmail: string;
  publicKey?: string;
}): Promise<SyncPasskey> {
  return request<SyncPasskey>('/passkeys', {
    method: 'POST',
    body: JSON.stringify(key),
  });
}

export function touchPasskey(id: string): Promise<SyncPasskey> {
  return request<SyncPasskey>(`/passkeys/${encodeURIComponent(id)}/last-used`, {
    method: 'PUT',
  });
}

export function deletePasskey(id: string): Promise<void> {
  return request(`/passkeys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- one-time migration from the localStorage era ---------------------------------

// Legacy keys written by the pre-backend implementation.
const LEGACY_KEYS = [
  'nixre_plugins_available',
  'nixre_plugins_enabled',
  'nixre_plugin_configs',
  'nixre_assistant_profiles',
  'nixre_assistant_conversations',
  'nixre_passkeys_vault',
];

const MIGRATION_FLAG = 'nixre_sync_migrated';

/**
 * Upload any legacy localStorage data to the server once, then remove it.
 * Safe to call on every app boot: after the first successful run a flag
 * prevents repeats, and server data is never overwritten with empty values.
 */
export async function migrateLegacyLocalStorage(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG)) return;

  const legacy: Record<string, unknown> = {};
  for (const key of LEGACY_KEYS) {
    const raw = localStorage.getItem(key);
    if (!raw) continue;
    try {
      legacy[key] = JSON.parse(raw);
    } catch {
      // Corrupt entry — drop it.
      localStorage.removeItem(key);
    }
  }

  try {
    if (Object.keys(legacy).length > 0) {
      const existing = await getAllPrefs();
      const prefKeys: Record<string, string> = {
        nixre_plugins_available: 'plugins_available',
        nixre_plugins_enabled: 'plugins_enabled',
        nixre_plugin_configs: 'plugin_configs',
        nixre_assistant_profiles: 'assistant_profiles',
      };

      const uploads: Promise<unknown>[] = [];
      for (const [storageKey, prefKey] of Object.entries(prefKeys)) {
        if (legacy[storageKey] !== undefined && existing[prefKey] === undefined) {
          uploads.push(putPref(prefKey, legacy[storageKey]));
        }
      }

      // Conversations and passkeys become rows, not prefs.
      const legacyConvos = legacy['nixre_assistant_conversations'];
      if (Array.isArray(legacyConvos) && legacyConvos.length > 0) {
        const onServer = new Set((await listConversations()).map(c => c.id));
        for (const c of legacyConvos as any[]) {
          if (c?.id && !onServer.has(c.id) && Array.isArray(c.messages)) {
            uploads.push(
              createConversation(c.repoPath || 'unknown', c.title || 'Untitled', c.messages).catch(
                // Preserve ids by retrying as an update if the id is taken.
                () => updateConversation(c.id, { messages: c.messages }),
              ),
            );
          }
        }
      }

      const legacyKeys = legacy['nixre_passkeys_vault'];
      if (Array.isArray(legacyKeys) && legacyKeys.length > 0) {
        const onServer = new Set((await listPasskeys()).map(k => k.id));
        for (const k of legacyKeys as any[]) {
          if (k?.id && !onServer.has(k.id)) {
            uploads.push(
              createPasskey({
                id: k.id,
                name: k.name || 'Passkey',
                userUid: k.userUid || '',
                userEmail: k.userEmail || '',
              }),
            );
          }
        }
      }

      await Promise.all(uploads);
    }
    // Migration done (or nothing to migrate) — clean up and flag.
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
    localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
  } catch {
    // Server unreachable — try again on next boot.
  }
}

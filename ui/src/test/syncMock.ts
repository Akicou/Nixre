// In-memory mock of the nixre-sync backend for tests.
//
// It intercepts global fetch for /api/sync/v1/* URLs, so the server-backed
// storage modules (pluginPreferences, assistantProfiles, assistantEngine,
// webauthn) run without a network. Non-sync URLs fall through to a real
// fetch (or fail loudly if no backend exists).
//
// Usage:
//   import { installSyncFetchMock, syncMockState } from './syncMock';
//   installSyncFetchMock();            // before tests run
//   syncMockReset();                   // in beforeEach

export interface SyncMockConversation {
  id: string;
  repoPath: string;
  title: string;
  messages: unknown[];
  updatedAt: number;
}

export interface SyncMockPasskey {
  id: string;
  name: string;
  userUid: string;
  userEmail: string;
  publicKey?: string | null;
  createdAt: number;
  lastUsedAt?: number;
}

interface SyncMockDb {
  prefs: Record<string, unknown>;
  conversations: SyncMockConversation[];
  passkeys: SyncMockPasskey[];
}

export const syncMockDb: SyncMockDb = { prefs: {}, conversations: [], passkeys: [] };

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}_mock_${idSeq++}`;

export function syncMockReset(seed?: Partial<SyncMockDb>): void {
  syncMockDb.prefs = { ...(seed?.prefs ?? {}) };
  syncMockDb.conversations = [...(seed?.conversations ?? [])];
  syncMockDb.passkeys = [...(seed?.passkeys ?? [])];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

async function handleSync(url: URL, method: string, body: any): Promise<Response | null> {
  if (url.pathname !== '/api/sync/v1/prefs' && !url.pathname.startsWith('/api/sync/v1/')) {
    return null;
  }
  const path = url.pathname.replace('/api/sync/v1', '');

  // --- prefs ---------------------------------------------------------------
  if (path === '/prefs' && method === 'GET') return json(200, syncMockDb.prefs);

  const prefMatch = path.match(/^\/prefs\/(.+)$/);
  if (prefMatch) {
    const key = decodeURIComponent(prefMatch[1]);
    if (method === 'PUT') {
      syncMockDb.prefs[key] = body?.value;
      return json(200, { key, value: body?.value });
    }
    if (method === 'DELETE') {
      delete syncMockDb.prefs[key];
      return json(200, { ok: true });
    }
  }

  // --- conversations ---------------------------------------------------------
  if (path === '/conversations' && method === 'GET') {
    const repo = url.searchParams.get('repo');
    const rows = syncMockDb.conversations.filter(c => !repo || c.repoPath === repo);
    return json(200, rows);
  }
  if (path === '/conversations' && method === 'POST') {
    const row: SyncMockConversation = {
      id: nextId('conv'),
      repoPath: String(body?.repoPath ?? ''),
      title: String(body?.title ?? 'Untitled'),
      messages: Array.isArray(body?.messages) ? body.messages : [],
      updatedAt: Date.now(),
    };
    syncMockDb.conversations.push(row);
    return json(201, row);
  }
  const convoMatch = path.match(/^\/conversations\/([^/]+)$/);
  if (convoMatch) {
    const id = decodeURIComponent(convoMatch[1]);
    const row = syncMockDb.conversations.find(c => c.id === id);
    if (method === 'GET') {
      return row ? json(200, row) : json(404, { message: 'Conversation not found' });
    }
    if (method === 'PUT') {
      if (!row) return json(404, { message: 'Conversation not found' });
      if (body?.title !== undefined) row.title = body.title;
      if (body?.messages !== undefined) row.messages = body.messages;
      row.updatedAt = Date.now();
      return json(200, row);
    }
    if (method === 'DELETE') {
      syncMockDb.conversations = syncMockDb.conversations.filter(c => c.id !== id);
      return json(200, { ok: true });
    }
  }

  // --- passkeys ----------------------------------------------------------------
  if (path === '/passkeys' && method === 'GET') return json(200, syncMockDb.passkeys);
  if (path === '/passkeys' && method === 'POST') {
    const row: SyncMockPasskey = {
      id: String(body?.id ?? nextId('pk')),
      name: String(body?.name ?? 'Passkey'),
      userUid: String(body?.userUid ?? ''),
      userEmail: String(body?.userEmail ?? ''),
      publicKey: body?.publicKey ?? null,
      createdAt: Date.now(),
    };
    syncMockDb.passkeys.push(row);
    return json(201, row);
  }
  const touchMatch = path.match(/^\/passkeys\/([^/]+)\/last-used$/);
  if (touchMatch && method === 'PUT') {
    const row = syncMockDb.passkeys.find(k => k.id === decodeURIComponent(touchMatch[1]));
    if (!row) return json(404, { message: 'Passkey not found' });
    row.lastUsedAt = Date.now();
    return json(200, row);
  }
  const pkMatch = path.match(/^\/passkeys\/([^/]+)$/);
  if (pkMatch && method === 'DELETE') {
    const id = decodeURIComponent(pkMatch[1]);
    syncMockDb.passkeys = syncMockDb.passkeys.filter(k => k.id !== id);
    return json(200, { ok: true });
  }

  return json(404, { message: `No sync mock route for ${method} ${path}` });
}

// --- AI endpoints (used by assistantProfiles via lib/aiApi) --------------------
// Minimal in-memory provider profile so provider-backed code paths work in
// tests without a live backend.

export const aiMockProfile = {
  provider: 'deepseek',
  providerLabel: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com',
  keyConfigured: false,
  keyMask: null,
  validatedAt: null,
  model: 'deepseek-chat',
  reasoningLevel: 'none',
  interleavedReasoning: false,
  models: ['deepseek-chat', 'deepseek-reasoner'] as string[],
  updatedAt: 1700000000000,
};

function handleAi(path: string, method: string, body: any): Response | null {
  if (path !== '/ai/profile' && path !== '/ai/models' && path !== '/ai/chat') return null;
  if (path === '/ai/profile' && method === 'GET') {
    return json(200, aiMockProfile);
  }
  if (path === '/ai/profile' && method === 'PUT') {
    Object.assign(aiMockProfile, {
      provider: body?.provider ?? aiMockProfile.provider,
      baseUrl: body?.baseUrl ?? aiMockProfile.baseUrl,
      model: body?.model ?? aiMockProfile.model,
      reasoningLevel: body?.reasoningLevel ?? aiMockProfile.reasoningLevel,
      interleavedReasoning: body?.interleavedReasoning ?? aiMockProfile.interleavedReasoning,
      validatedAt: body?.apiKey ? Date.now() : aiMockProfile.validatedAt,
    });
    return json(200, { ...aiMockProfile, validated: true });
  }
  if (path === '/ai/models' && method === 'GET') {
    return json(200, { models: aiMockProfile.models, cached: true });
  }
  return json(404, { message: `No ai mock route for ${method} ${path}` });
}

/** Install the /api/sync/v1 fetch interceptor (idempotent). */
export function installSyncFetchMock(): void {
  const realFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw, 'http://mock.local');
    const syncResponse = await handleSync(url, init?.method ?? 'GET', parseBody(init?.body));
    if (syncResponse) return syncResponse;
    // aiApi talks to /api/v1/ai/* — mock that too when tests use it.
    const aiResponse = handleAi(url.pathname.replace('/api/v1', ''), init?.method ?? 'GET', parseBody(init?.body));
    if (aiResponse) return aiResponse;
    return realFetch(input, init);
  }) as typeof fetch;
}

function parseBody(body: BodyInit | null | undefined): any {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

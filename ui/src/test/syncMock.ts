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
  run_status?: 'idle' | 'running' | 'stopping';
  run_error?: string | null;
  run_queue?: unknown[];
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
export let lastAiJobBody: Record<string, unknown> | null = null;

let idSeq = 0;
const nextId = (prefix: string) => `${prefix}_mock_${idSeq++}`;

export function syncMockReset(seed?: Partial<SyncMockDb>): void {
  syncMockDb.prefs = { ...(seed?.prefs ?? {}) };
  syncMockDb.conversations = [...(seed?.conversations ?? [])];
  syncMockDb.passkeys = [...(seed?.passkeys ?? [])];
  lastAiJobBody = null;
  // Reset the AI provider store to a single validated DeepSeek.
  aiMockProviders.length = 0;
  aiMockProviders.push({
    id: 1,
    label: 'DeepSeek',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyConfigured: true,
    keyMask: '…test',
    validatedAt: 1700000000000,
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabledModels: ['deepseek-chat', 'deepseek-reasoner'],
    isDefault: true,
    created: 1700000000000,
    updated: 1700000000000,
  });
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
      run_status: 'idle',
      run_queue: [],
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
// In-memory multi-provider store so provider-backed code paths work in tests
// without a live backend.

export const aiMockProviders: Array<{
  id: number;
  label: string;
  provider: string;
  providerLabel: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyMask: string | null;
  validatedAt: number | null;
  defaultModel: string;
  models: string[];
  enabledModels: string[];
  isDefault: boolean;
  created: number;
  updated: number;
}> = [
  {
    id: 1,
    label: 'DeepSeek',
    provider: 'deepseek',
    providerLabel: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyConfigured: true,
    keyMask: '…test',
    validatedAt: 1700000000000,
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    enabledModels: ['deepseek-chat', 'deepseek-reasoner'],
    isDefault: true,
    created: 1700000000000,
    updated: 1700000000000,
  },
];
let aiNextId = 2;

const aiMockProfile = () => {
  const active = aiMockProviders.find(p => p.isDefault) ?? aiMockProviders[0];
  if (!active) {
    return {
      provider: '', providerLabel: '', baseUrl: '',
      keyConfigured: false, keyMask: null, validatedAt: null,
      model: '', reasoningLevel: 'none', interleavedReasoning: false,
      models: [], providers: [], updatedAt: 0,
    };
  }
  return {
    ...active,
    model: active.defaultModel,
    models: active.enabledModels,
    providers: aiMockProviders,
    reasoningLevel: (active as any).reasoningLevel ?? 'none',
    interleavedReasoning: (active as any).interleavedReasoning ?? false,
  };
};

function handleAi(path: string, method: string, body: any): Response | null {
  if (!/^\/ai\//.test(path)) return null;

  if (path === '/ai/profile' && method === 'GET') return json(200, aiMockProfile());
  if (path === '/ai/profile' && method === 'PUT') {
    // Legacy single-profile shape: routes into the active provider.
    if (aiMockProviders.length === 0) return json(200, { ...aiMockProfile(), validated: false });
    const target = aiMockProviders.find(p => p.isDefault) ?? aiMockProviders[0];
    if (body?.model) target.defaultModel = String(body.model);
    if (Array.isArray(body?.models) && body.models.length > 0) target.enabledModels = body.models;
    if (body?.reasoningLevel !== undefined || body?.interleavedReasoning !== undefined) {
      // reasoning prefs ride on the derived profile; mirror them on the row
      (target as any).reasoningLevel = body?.reasoningLevel ?? (target as any).reasoningLevel ?? 'none';
      (target as any).interleavedReasoning = body?.interleavedReasoning ?? (target as any).interleavedReasoning ?? false;
    }
    return json(200, { ...aiMockProfile(), validated: target.validatedAt != null });
  }
  if (path === '/ai/providers' && method === 'GET') return json(200, aiMockProviders);

  if (path === '/ai/providers' && method === 'POST') {
    const row = {
      id: aiNextId++,
      label: body?.label || 'Provider',
      provider: body?.provider || 'deepseek',
      providerLabel: body?.provider || 'Provider',
      baseUrl: body?.baseUrl || '',
      keyConfigured: Boolean(body?.apiKey),
      keyMask: body?.apiKey ? `…${String(body.apiKey).slice(-4)}` : null,
      validatedAt: Date.now(),
      defaultModel: 'mock-a',
      models: ['mock-a', 'mock-b'],
      enabledModels: ['mock-a'],
      isDefault: aiMockProviders.length === 0,
      created: Date.now(),
      updated: Date.now(),
    };
    aiMockProviders.push(row);
    return json(201, row);
  }

  const pm = path.match(/^\/ai\/providers\/(\d+)(\/models)?$/);
  if (pm) {
    const id = Number(pm[1]);
    const row = aiMockProviders.find(p => p.id === id);
    if (!row) return json(404, { message: 'Provider not found' });
    if (pm[2] === '/models' && method === 'GET') {
      return json(200, { models: row.models, cached: true });
    }
    if (method === 'PATCH') {
      Object.assign(row, {
        label: body?.label ?? row.label,
        baseUrl: body?.baseUrl ?? row.baseUrl,
        defaultModel: body?.defaultModel ?? row.defaultModel,
        enabledModels: body?.enabledModels ?? row.enabledModels,
      });
      if (body?.isDefault) aiMockProviders.forEach(p => (p.isDefault = p.id === id));
      row.updated = Date.now();
      return json(200, row);
    }
    if (method === 'DELETE') {
      const idx = aiMockProviders.findIndex(p => p.id === id);
      aiMockProviders.splice(idx, 1);
      if (row.isDefault && aiMockProviders.length > 0) aiMockProviders[0].isDefault = true;
      return json(200, { ok: true });
    }
  }

  if (path === '/ai/chat' && method === 'POST') {
    // Minimal SSE stream: reasoning + text + done, like the real proxy.
    const frames = [
      { type: 'reasoning', text: 'Checking the suite first. ' },
      { type: 'text', text: 'The suite is green: **15 tests passing** across 2 files. ' },
      { type: 'text', text: 'Nothing blocking for this change.' },
      { type: 'done' },
    ]
      .map(evt => `data: ${JSON.stringify(evt)}`)
      .join('\n\n');
    return new Response(`${frames}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  if (path === '/ai/jobs' && method === 'POST') {
    lastAiJobBody = body ?? null;
    let row = body?.conversationId
      ? syncMockDb.conversations.find(c => c.id === body.conversationId)
      : undefined;
    if (!row) {
      row = {
        id: nextId('conv'),
        repoPath: String(body?.repoPath ?? ''),
        title: String(body?.prompt || 'Untitled').slice(0, 48),
        messages: [],
        updatedAt: Date.now(),
        run_status: 'idle',
        run_queue: [],
      };
      syncMockDb.conversations.push(row);
    }
    if (row.run_status === 'running') {
      const item = {
        id: nextId('q'),
        kind: 'followup',
        text: String(body?.prompt || '(image)'),
        images: body?.images,
      };
      row.run_queue = [...(row.run_queue ?? []), item];
      row.updatedAt = Date.now();
      return json(200, { conversationId: row.id, run_status: 'running', queued: true, item });
    }
    const userMsg = {
      id: nextId('u'),
      role: 'user',
      content: String(body?.prompt || '(image)'),
      images: body?.images,
      createdAt: Date.now(),
    };
    row.messages = [...row.messages, userMsg];
    row.title = row.title && row.title !== 'Untitled' ? row.title : String(body?.prompt || 'Untitled').slice(0, 48);
    row.run_status = 'running';
    row.updatedAt = Date.now();
    return json(200, { conversationId: row.id, run_status: 'running', queued: false });
  }

  const jobEvents = path.match(/^\/ai\/jobs\/([^/]+)\/events$/);
  if (jobEvents && method === 'GET') {
    const id = decodeURIComponent(jobEvents[1]);
    const row = syncMockDb.conversations.find(c => c.id === id);
    if (!row) return json(404, { message: 'Conversation not found' });
    const assistantText =
      'The suite is green: **15 tests passing** across 2 files. Nothing blocking for this change.';
    const frames: object[] = [
      {
        type: 'snapshot',
        conversation: {
          ...row,
          run_status: row.run_status || 'idle',
          run_queue: row.run_queue || [],
        },
      },
    ];
    if (row.run_status === 'running') {
      frames.push(
        { type: 'reasoning', blockId: 'r1', text: 'Checking the suite first. ' },
        { type: 'message_text', text: 'The suite is green: **15 tests passing** across 2 files. ' },
        { type: 'message_text', text: 'Nothing blocking for this change.' },
      );
      row.messages = [
        ...row.messages,
        {
          id: nextId('a'),
          role: 'assistant',
          content: assistantText,
          parts: [
            { type: 'reasoning', id: 'r1', text: 'Checking the suite first. ' },
            { type: 'text', text: assistantText },
          ],
          createdAt: Date.now(),
        },
      ];
      row.run_status = 'idle';
      row.updatedAt = Date.now();
      frames.push({ type: 'status', run_status: 'idle' }, { type: 'done' });
    } else {
      frames.push({ type: 'status', run_status: row.run_status || 'idle' }, { type: 'done' });
    }
    const bodyText = frames.map(evt => `data: ${JSON.stringify(evt)}`).join('\n\n');
    return new Response(`${bodyText}\n\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  const jobStop = path.match(/^\/ai\/jobs\/([^/]+)\/stop$/);
  if (jobStop && method === 'POST') {
    const id = decodeURIComponent(jobStop[1]);
    const row = syncMockDb.conversations.find(c => c.id === id);
    if (row) row.run_status = 'idle';
    return json(200, { ok: true, run_status: 'idle' });
  }

  const jobQueue = path.match(/^\/ai\/jobs\/([^/]+)\/queue(?:\/([^/]+))?$/);
  if (jobQueue) {
    const id = decodeURIComponent(jobQueue[1]);
    const row = syncMockDb.conversations.find(c => c.id === id);
    if (!row) return json(404, { message: 'Conversation not found' });
    if (method === 'POST') {
      const item = {
        id: nextId('q'),
        kind: body?.kind || 'followup',
        text: String(body?.text || ''),
        images: body?.images,
      };
      row.run_queue = [...(row.run_queue ?? []), item];
      return json(200, { item, run_queue: row.run_queue });
    }
    if (method === 'DELETE' && jobQueue[2]) {
      const itemId = decodeURIComponent(jobQueue[2]);
      row.run_queue = (row.run_queue ?? []).filter((q: any) => q.id !== itemId);
      return json(200, { run_queue: row.run_queue });
    }
  }

  if (path === '/ai/env-feedback' && method === 'GET') {
    return json(200, { reports: [] });
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

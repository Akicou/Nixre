// AI API client — multi-provider management and streaming chat against
// nixre-core. API keys live server-side; this client only sees a mask.

export interface AiProvider {
  id: number;
  label: string;
  provider: string;
  providerLabel: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyMask: string | null;
  validatedAt: number | null;
  defaultModel: string;
  models: string[];          // full cached list from the provider
  enabledModels: string[];   // user-picked subset used in chat
  isDefault: boolean;
  created: number;
  updated: number;
}

export interface AiProfile {
  provider: string;
  providerLabel: string;
  baseUrl: string;
  keyConfigured: boolean;
  keyMask: string | null;
  validatedAt: number | null;
  model: string;
  reasoningLevel: string;
  interleavedReasoning: boolean;
  models: string[];
  providers?: AiProvider[];
  updatedAt: number;
}

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export type ChatStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('nixre_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...authHeaders(), ...(init.headers as Record<string, string> | undefined) },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {}
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export function getAiProfile(): Promise<AiProfile> {
  return request<AiProfile>('/ai/profile');
}

// --- multi-provider CRUD --------------------------------------------------------

export function listAiProviders(): Promise<AiProvider[]> {
  return request<AiProvider[]>('/ai/providers');
}

export interface CreateProviderInput {
  label: string;
  provider: string;
  baseUrl?: string;
  apiKey: string;
  defaultModel?: string;
}

export function createAiProvider(input: CreateProviderInput): Promise<AiProvider> {
  return request<AiProvider>('/ai/providers', { method: 'POST', body: JSON.stringify(input) });
}

export interface UpdateProviderInput {
  label?: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  enabledModels?: string[];
  isDefault?: boolean;
}

export function updateAiProvider(id: number, input: UpdateProviderInput): Promise<AiProvider> {
  return request<AiProvider>(`/ai/providers/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteAiProvider(id: number): Promise<void> {
  return request(`/ai/providers/${id}`, { method: 'DELETE' });
}

export function fetchProviderModels(id: number, refresh = false): Promise<{ models: string[]; cached: boolean }> {
  return request(`/ai/providers/${id}/models${refresh ? '?refresh=1' : ''}`);
}

export interface SaveProfileInput {
  provider: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  reasoningLevel: string;
  interleavedReasoning: boolean;
}

export function saveAiProfile(input: SaveProfileInput): Promise<AiProfile & { validated: boolean }> {
  return request('/ai/profile', { method: 'PUT', body: JSON.stringify(input) });
}

export function listAiModels(): Promise<{ models: string[]; cached: boolean; stale?: boolean }> {
  return request('/ai/models');
}

// Streams a chat completion; `onEvent` receives unified events.
export async function streamAiChat(
  messages: ChatTurn[],
  opts: { model?: string; reasoningLevel?: string },
  onEvent: (evt: ChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch('/api/v1/ai/chat', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messages, ...opts }),
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {}
    onEvent({ type: 'error', message: msg });
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          onEvent(JSON.parse(line.slice(5).trim()) as ChatStreamEvent);
        } catch {}
      }
    }
  }
}

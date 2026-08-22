// AI API client — multi-provider management and streaming chat against
// nixre-core. API keys live server-side; this client only sees a mask.

/**
 * Sentinel model id meaning "whatever model the server currently has
 * loaded". Verified live against Unsloth Studio (any unrecognized model
 * string routes to the loaded model) and matches llama.cpp behavior
 * (model field ignored, serves the launched model). LM Studio honors it
 * when Just-in-Time model loading is enabled.
 */
export const LOCAL_MODEL = 'local-model';

/** True for provider kinds that serve a local, user-run inference server. */
export function isLocalKind(provider: string): boolean {
  return provider === 'custom' || provider === 'ollama';
}

/** Display label for a model id (sentinels get a friendly name). */
export function modelLabel(m: string): string {
  return m === LOCAL_MODEL ? 'loaded model ⟳' : m;
}

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

export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatTurn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  // String for ordinary turns; multimodal user turns use OpenRouter/OpenAI
  // content parts (text + image_url).
  content: string | ChatContentPart[];
  // Present on assistant messages that request agent tools.
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  // Present on tool-result messages.
  tool_call_id?: string;
}

export type ChatStreamEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'finish'; reason: string }
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

// Executes one assistant tool server-side (permission-checked there).
export async function executeAssistantTool(
  repoPath: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await fetch('/api/v1/ai/tools', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ repoPath, tool, args }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {}
    throw new Error(msg);
  }
  const body = await res.json();
  return String(body.output ?? '');
}

// Streams a chat completion; `onEvent` receives unified events.
// `tools` asks the provider for agent tool-calls (see assistantEngine).
export async function streamAiChat(
  messages: ChatTurn[],
  opts: { model?: string; reasoningLevel?: string; tools?: boolean; signal?: AbortSignal },
  onEvent: (evt: ChatStreamEvent) => void,
): Promise<void> {
  const res = await fetch('/api/v1/ai/chat', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ messages, ...opts }),
    signal: opts.signal,
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

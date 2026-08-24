// Client for server-side agent jobs. Turns keep running after the tab closes;
// this module only follows (or stops) them.

import type { ChatImage } from './chatImages';
import type { ChatMessage, EngineEvent } from './assistantEngine';

const BASE = '/api/v1';

export type RunStatus = 'idle' | 'running' | 'stopping';

export interface RunQueueItem {
  id: string;
  kind: 'steer' | 'followup';
  text: string;
  images?: ChatImage[];
}

export interface JobConversation {
  id: string;
  repoPath: string;
  title: string;
  messages: unknown[];
  updatedAt: number;
  run_status: RunStatus;
  run_error?: string | null;
  run_queue?: RunQueueItem[];
}

export type JobStreamEvent =
  | EngineEvent
  | { type: 'snapshot'; conversation: JobConversation }
  | { type: 'status'; run_status: RunStatus; error?: string }
  | { type: 'queue'; items: RunQueueItem[] }
  | { type: 'user_message'; message: ChatMessage }
  | { type: 'heartbeat' };

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('nixre_token');
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function jobRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
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
    throw new Error(msg);
  }
  const contentType = res.headers.get('content-type') || '';
  return (contentType.includes('application/json') ? res.json() : {}) as T;
}

export const ENV_AUDIT_PROMPT =
  'Audit this agent sandbox and Nixre tools for gaps from this session. Probe the environment, call submit_env_feedback, then summarize what is missing vs what is a permission gate. Do not edit the Dockerfile.';

export function startAgentJob(body: {
  conversationId?: string | null;
  repoPath: string;
  prompt: string;
  images?: ChatImage[];
  mode?: string;
  model?: string;
  reasoningLevel?: string;
  extraContext?: string | { label: string; text: string } | null;
  kind?: 'chat' | 'env_audit';
}): Promise<{ conversationId: string; run_status: RunStatus; queued?: boolean; item?: RunQueueItem }> {
  return jobRequest('/ai/jobs', { method: 'POST', body: JSON.stringify(body) });
}

export function stopAgentJob(conversationId: string): Promise<{ ok: boolean; run_status: RunStatus }> {
  return jobRequest(`/ai/jobs/${encodeURIComponent(conversationId)}/stop`, { method: 'POST' });
}

export function queueAgentJob(
  conversationId: string,
  body: { kind: 'steer' | 'followup'; text: string; images?: ChatImage[]; jobKind?: 'env_audit' },
): Promise<{ item: RunQueueItem; run_queue: RunQueueItem[] }> {
  return jobRequest(`/ai/jobs/${encodeURIComponent(conversationId)}/queue`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function deleteQueuedJob(conversationId: string, itemId: string): Promise<{ run_queue: RunQueueItem[] }> {
  return jobRequest(
    `/ai/jobs/${encodeURIComponent(conversationId)}/queue/${encodeURIComponent(itemId)}`,
    { method: 'DELETE' },
  );
}

function parseSseBuffer(buf: string): { frames: JobStreamEvent[]; rest: string } {
  const frames: JobStreamEvent[] = [];
  let rest = buf;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) !== -1) {
    const chunk = rest.slice(0, idx);
    rest = rest.slice(idx + 2);
    for (const line of chunk.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        frames.push(JSON.parse(line.slice(5).trim()) as JobStreamEvent);
      } catch {
        /* ignore malformed */
      }
    }
  }
  return { frames, rest };
}

/** Follow a job's snapshot + live events. Disconnect does not stop the job. */
export async function subscribeAgentJob(
  conversationId: string,
  onEvent: (evt: JobStreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/ai/jobs/${encodeURIComponent(conversationId)}/events`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok || !res.body) {
    let msg = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      if (body?.message) msg = body.message;
    } catch {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parsed = parseSseBuffer(buf);
    buf = parsed.rest;
    for (const evt of parsed.frames) onEvent(evt);
  }
}

export function queueToLocal(items: RunQueueItem[] | undefined): {
  id: string;
  text: string;
  images: ChatImage[];
  kind?: RunQueueItem['kind'];
}[] {
  return (items ?? []).map(i => ({
    id: i.id,
    text: i.text,
    images: i.images ?? [],
    kind: i.kind,
  }));
}

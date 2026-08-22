// AI provider adapters — real credential validation, model listing, and
// streaming chat for every supported provider, behind one unified interface.
//
// Supported:
//   deepseek  (OpenAI-compatible, https://api.deepseek.com)
//   openai    (https://api.openai.com)
//   anthropic (https://api.anthropic.com)
//   ollama    (local, OpenAI-compatible on the given base URL)
//   custom    (any OpenAI-compatible endpoint via base_url)
//
// API keys live only in nixre-core (encrypted at rest). The browser never
// sees them; chat requests are proxied through /ai/chat.

import crypto from 'node:crypto';

// --- key encryption (AES-256-GCM, key derived from AI_SECRET) ---------------

const KEY = crypto.createHash('sha256')
  .update(process.env.AI_SECRET || process.env.INTERNAL_TOKEN || 'nixre-dev-ai-secret')
  .digest();

export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ct].map(b => b.toString('base64')).join('.');
}

export function decryptSecret(blob) {
  try {
    const [iv, tag, ct] = blob.split('.').map(s => Buffer.from(s, 'base64'));
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function maskSecret(plain) {
  if (!plain) return null;
  return `…${plain.slice(-4)}`;
}

// --- provider registry -----------------------------------------------------------

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    defaultBase: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    kind: 'openai-compatible',
  },
  openai: {
    label: 'OpenAI',
    defaultBase: 'https://api.openai.com',
    defaultModel: 'gpt-4o-mini',
    kind: 'openai-compatible',
  },
  anthropic: {
    label: 'Anthropic',
    defaultBase: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-20250514',
    kind: 'anthropic',
  },
  ollama: {
    label: 'Ollama (local)',
    defaultBase: 'http://127.0.0.1:11434',
    defaultModel: 'llama3.1',
    kind: 'openai-compatible',
    local: true,
  },
  custom: {
    label: 'Custom (OpenAI-compatible)',
    defaultBase: '',
    defaultModel: '',
    kind: 'openai-compatible',
    needsBaseUrl: true,
  },
};

function resolveProvider(provider, baseUrl) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`Unknown provider '${provider}'`);
  const base = (baseUrl || def.defaultBase || '').replace(/\/+$/, '');
  if (def.needsBaseUrl && !base) throw new Error('A base URL is required for custom providers');
  return { def, base };
}

// Build the API root from a user-supplied base URL. Many OpenAI-compatible
// servers expose the API at `.../v1` (the user pastes the full root, e.g.
// `http://host:8888/v1`), while canonical providers use the bare domain.
// Normalize: append `/v1` only when the base doesn't already end with it.
function apiRoot(base) {
  return /\/v\d+$/.test(base) ? base : `${base}/v1`;
}

// --- model listing ----------------------------------------------------------------

export async function listModels(provider, apiKey, baseUrl) {
  const { def, base } = resolveProvider(provider, baseUrl);

  let url;
  const headers = {};
  const root = apiRoot(base);
  if (def.kind === 'anthropic') {
    url = `${root}/models`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    url = `${root}/models`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (r.status === 401 || r.status === 403) {
    throw new AuthError('Invalid API key');
  }
  if (!r.ok) {
    throw new Error(`Provider returned HTTP ${r.status}`);
  }
  const body = await r.json();
  // OpenAI-compatible: {data: [{id}]}; Anthropic: {data: [{id}]} — same shape.
  // Some servers (e.g. Unsloth Studio) add a `loaded` flag: only the loaded
  // model(s) can actually serve requests unless server-side model switching
  // is enabled. Prefer those when reported; otherwise return everything.
  const entries = body.data || [];
  const loaded = entries.filter(m => m?.loaded === true).map(m => m.id).filter(Boolean);
  const models = (loaded.length > 0 ? loaded : entries.map(m => m.id).filter(Boolean)).sort((a, b) =>
    a.localeCompare(b),
  );
  return models;
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

// --- streaming chat ---------------------------------------------------------------

// Streams a chat completion as unified SSE events:
//   data: {"type":"reasoning","text":"..."}
//   data: {"type":"text","text":"..."}
//   data: {"type":"error","message":"..."}
//   data: {"type":"done"}
// `send(event)` is an async callback; the caller wires it to the HTTP response.
export async function streamChat({ provider, apiKey, baseUrl, model, messages, reasoningLevel }, send) {
  const { def, base } = resolveProvider(provider, baseUrl);
  if (def.kind === 'anthropic') {
    return streamAnthropic({ base, apiKey, model, messages, reasoningLevel }, send);
  }
  return streamOpenAICompatible({ base, apiKey, model, messages, reasoningLevel, provider }, send);
}

async function streamOpenAICompatible({ base, apiKey, model, messages, reasoningLevel, provider }, send) {
  const body = {
    model,
    messages,
    stream: true,
  };
  // Reasoning-effort knobs: OpenAI o-series/gpt-5 accept reasoning_effort;
  // DeepSeek's reasoner model enables thinking by itself (no param needed).
  if (provider === 'openai' && /^(o\d|gpt-5)/.test(model) && reasoningLevel !== 'none') {
    body.reasoning_effort = reasoningLevel; // low | medium | high
  }

  const r = await fetch(`${apiRoot(base)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (r.status === 401 || r.status === 403) throw new AuthError('Invalid API key');
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Provider returned HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  await parseSSE(r, async (payload) => {
    if (payload === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = evt.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.reasoning_content) {
      await send({ type: 'reasoning', text: delta.reasoning_content });
    }
    if (delta.content) {
      await send({ type: 'text', text: delta.content });
    }
  });
}

async function streamAnthropic({ base, apiKey, model, messages, reasoningLevel }, send) {
  // Anthropic requires a system role outside the messages array.
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system');

  const body = {
    model,
    max_tokens: 8192,
    messages: rest,
    stream: true,
    ...(system ? { system } : {}),
  };
  const wantsThinking = reasoningLevel !== 'none';
  if (wantsThinking) {
    body.thinking = { type: 'enabled', budget_tokens: { low: 2048, medium: 8192, high: 16384 }[reasoningLevel] || 4096 };
  }

  const r = await fetch(`${apiRoot(base)}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (r.status === 401 || r.status === 403) throw new AuthError('Invalid API key');
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Provider returned HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
  }

  await parseSSE(r, async (payload) => {
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
        await send({ type: 'reasoning', text: evt.delta.thinking });
      } else if (evt.delta?.type === 'text_delta' && evt.delta.text) {
        await send({ type: 'text', text: evt.delta.text });
      }
    }
  });
}

// Shared SSE frame reader for provider responses.
async function parseSSE(response, onPayload) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) {
        await onPayload(line.slice(5).trim());
      }
    }
  }
}

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

// Ollama's OpenAI-compat API streams `delta.thinking` and accepts `think`.
function isOllamaLike(provider, base) {
  if (provider === 'ollama') return true;
  const u = String(base || '').toLowerCase();
  return /:11434\b/.test(u) || /\bollama\b/.test(u);
}

// OpenRouter-only request knob — do NOT send to generic custom endpoints.
function isOpenRouterBase(base) {
  return /openrouter\.ai/i.test(String(base || ''));
}

// Read reasoning from any OpenAI-compatible delta field (vLLM, DeepSeek, etc.).
// Dedupes identical text within one source: gateways like OpenRouter send the
// same delta under BOTH `reasoning` and `reasoning_details`, and some vLLM /
// Qwen builds send it under `thinking` and `reasoning_content`. Emitting both
// made every reasoning token append twice — the interleaved "LetLet me solve..."
// bug in the transcript and UI.
export function extractReasoningTexts(src) {
  const out = [];
  const seen = new Set();
  const push = t => {
    if (typeof t !== 'string' || !t) return;
    const key = t.trim();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(t);
  };
  if (!src || typeof src !== 'object') return out;
  if (typeof src.thinking === 'string' && src.thinking) push(src.thinking);
  if (typeof src.reasoning_content === 'string' && src.reasoning_content) {
    push(src.reasoning_content);
  }
  const r = src.reasoning;
  if (typeof r === 'string' && r) push(r);
  else if (r && typeof r === 'object') {
    if (typeof r.content === 'string' && r.content) push(r.content);
    else if (typeof r.text === 'string' && r.text) push(r.text);
  }
  if (Array.isArray(src.reasoning_details)) {
    for (const d of src.reasoning_details) {
      if (typeof d === 'string' && d) push(d);
      else if (typeof d?.text === 'string' && d.text) push(d.text);
    }
  }
  return out;
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
// A provider stream is cut off when it goes SILENT between chunks, not on a
// total wall clock — reasoning models can legally think for minutes on one
// request, and server-side agent jobs die invisibly when that gets aborted.
const STREAM_IDLE_MS = Number(process.env.AI_STREAM_IDLE_MS || 120_000);

// AbortController whose timer re-arms on every received byte. Outer signals
// (the job's Stop button) still abort through instantly, preserving their
// original AbortError reason.
function createStreamGuard(outerSignal) {
  const ctrl = new AbortController();
  let timer = null;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const err = new Error(`Provider stream stalled — no data for ${Math.round(STREAM_IDLE_MS / 1000)}s`);
      err.name = 'TimeoutError';
      ctrl.abort(err);
    }, STREAM_IDLE_MS);
  };
  arm();
  if (outerSignal) {
    if (outerSignal.aborted) ctrl.abort(outerSignal.reason);
    else outerSignal.addEventListener('abort', () => ctrl.abort(outerSignal.reason), { once: true });
  }
  return {
    signal: ctrl.signal,
    touch: () => {
      if (!ctrl.signal.aborted) arm();
    },
    dispose: () => clearTimeout(timer),
  };
}

export async function streamChat({ provider, apiKey, baseUrl, model, messages, reasoningLevel, tools, signal }, send) {
  const { def, base } = resolveProvider(provider, baseUrl);
  if (def.kind === 'anthropic') {
    return streamAnthropic({ base, apiKey, model, messages, reasoningLevel, tools, signal }, send);
  }
  return streamOpenAICompatible({ base, apiKey, model, messages, reasoningLevel, tools, provider, signal }, send);
}

// Unified agent-tool events forwarded to the browser:
//   {type:'tool_delta', index, id?, name?, argsDelta?} — streamed fragments
//   {type:'finish', reason:'stop'|'tool_calls'}
function toolSchemasOpenAI(tools) {
  return (tools ?? []).map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

async function streamOpenAICompatible({ base, apiKey, model, messages, reasoningLevel, tools, provider, signal }, send) {
  const ollamaLike = isOllamaLike(provider, base);
  const body = {
    model,
    messages,
    stream: true,
  };
  // OpenAI-style usage on the last SSE chunk. Local / Ollama servers often reject the field.
  if (!ollamaLike) {
    body.stream_options = { include_usage: true };
  }
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = toolSchemasOpenAI(tools);
    body.tool_choice = 'auto';
  }
  // Reasoning-effort knobs differ by gateway:
  //   OpenAI o-series/gpt-5 → reasoning_effort
  //   Ollama / :11434       → think (boolean or low|medium|high)
  //   OpenRouter-style      → reasoning: { effort, exclude:false }
  // DeepSeek reasoner enables thinking by itself (no param needed).
  // Generic custom OpenAI-compatible servers (vLLM, llama.cpp, etc.) stream
  // `delta.reasoning` / `delta.reasoning_content` without a special request
  // body — only OpenRouter and Ollama need provider-specific knobs.
  const isOpenRouter = isOpenRouterBase(base);
  if (provider === 'openai' && /^(o\d|gpt-5)/.test(model) && reasoningLevel !== 'none') {
    body.reasoning_effort = reasoningLevel; // low | medium | high
  }
  if (ollamaLike) {
    body.think = reasoningLevel === 'none'
      ? false
      : (['low', 'medium', 'high'].includes(reasoningLevel) ? reasoningLevel : true);
  } else if (isOpenRouter && reasoningLevel !== 'none') {
    // Maps to OpenRouter's `reasoning.effort` (Anthropic/Gemini translate it
    // server-side); exclude:false keeps reasoning tokens in the response.
    body.reasoning = {
      effort: ['low', 'medium', 'high'].includes(reasoningLevel) ? reasoningLevel : 'medium',
      exclude: false,
    };
  }

  const guard = createStreamGuard(signal);
  try {
    const r = await fetch(`${apiRoot(base)}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: guard.signal,
    });
    if (r.status === 401 || r.status === 403) throw new AuthError('Invalid API key');
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`Provider returned HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
    }

    const thinkTagState = { inside: false, endTag: '' };
    let sawReasoning = false;
    await parseSSE(r, async (payload) => {
    if (payload === '[DONE]') return;
    let evt;
    try {
      evt = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = evt.choices?.[0]?.delta;
    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        await send({
          type: 'tool_delta',
          index: Number(tc.index ?? 0),
          id: tc.id || undefined,
          name: tc.function?.name || undefined,
          argsDelta: tc.function?.arguments || undefined,
        });
      }
    }
    const finish = evt.choices?.[0]?.finish_reason;
    if (finish) {
      await send({ type: 'finish', reason: finish === 'tool_calls' ? 'tool_calls' : 'stop' });
    }
    if (evt.usage) {
      const input = Number(evt.usage.prompt_tokens ?? evt.usage.input_tokens ?? 0);
      const output = Number(evt.usage.completion_tokens ?? evt.usage.output_tokens ?? 0);
      await send({
        type: 'usage',
        usage: { input, output, total: Number(evt.usage.total_tokens ?? input + output) },
      });
    }
    if (!delta && !evt.choices?.[0]?.message) return;
    // Reasoning arrives under different keys across OpenAI-compatible
    // gateways: `thinking` (Ollama), `reasoning_content` (DeepSeek),
    // `reasoning` (OpenRouter / most gateways), or `reasoning_details`
    // (OpenRouter structured form). Some local models also wrap thoughts
    // in <think>…</think> inside `content`.
    const src = delta || {};
    const message = evt.choices?.[0]?.message;
    // Dedupe identical reasoning within one chunk: many gateways send the same
    // delta under BOTH `reasoning` and `reasoning_details` (OpenRouter) or
    // `thinking` and `reasoning_content` (vLLM/Qwen). Emitting both appended
    // every reasoning token twice — the interleaved "LetLet me solve..." bug in
    // the transcript and UI.
    const reasoningTexts = extractReasoningTexts(src);
    // Only fall back to the whole `message` when the stream has produced no
    // reasoning yet — some gateways attach the full reasoning block on the
    // final chunk; emitting it after streamed deltas doubles everything.
    const useMessageFallback = reasoningTexts.length === 0 && message && !sawReasoning;
    let pending = Promise.resolve();
    const emitReasoning = text => {
      if (!text) return;
      sawReasoning = true;
      pending = pending.then(() => send({ type: 'reasoning', text }));
    };
    for (const text of reasoningTexts) emitReasoning(text);
    if (useMessageFallback) {
      for (const text of extractReasoningTexts(message)) emitReasoning(text);
    }
    await pending;
    if (src.content) {
      const parts = splitThinkTags(src.content, thinkTagState);
      for (const part of parts) {
        if (part.text) await send({ type: part.kind, text: part.text });
      }
    }
  }, () => guard.touch());
  } finally {
    guard.dispose();
  }
}

// Thinking tags some OpenAI-compatible servers embed inside `content`.
const THINK_OPEN = '<' + 'think' + '>';
const THINK_CLOSE = '</' + 'think' + '>';
const THINK_TAG_PAIRS = [
  [THINK_OPEN, THINK_CLOSE],
  ['<thinking>', '</thinking>'],
  ['<reasoning>', '</reasoning>'],
  ['<think>', '</think>'],
];

function splitThinkTags(text, state) {
  const out = [];
  let rest = text;
  while (rest) {
    if (state.inside && state.endTag) {
      const end = rest.indexOf(state.endTag);
      if (end === -1) {
        out.push({ kind: 'reasoning', text: rest });
        return out;
      }
      if (end > 0) out.push({ kind: 'reasoning', text: rest.slice(0, end) });
      const closed = state.endTag;
      state.inside = false;
      state.endTag = '';
      rest = rest.slice(end + closed.length);
      continue;
    }
    let earliest = -1;
    let startTag = '';
    let endTag = '';
    for (const [start, end] of THINK_TAG_PAIRS) {
      const idx = rest.indexOf(start);
      if (idx !== -1 && (earliest === -1 || idx < earliest)) {
        earliest = idx;
        startTag = start;
        endTag = end;
      }
    }
    if (earliest === -1) {
      out.push({ kind: 'text', text: rest });
      return out;
    }
    if (earliest > 0) out.push({ kind: 'text', text: rest.slice(0, earliest) });
    state.inside = true;
    state.endTag = endTag;
    rest = rest.slice(earliest + startTag.length);
  }
  return out;
}

async function streamAnthropic({ base, apiKey, model, messages, reasoningLevel, tools, signal }, send) {
  // Anthropic requires a system role outside the messages array.
  const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system').map(m => {
    // OpenAI-style tool result messages → Anthropic tool_result blocks.
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }],
      };
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input });
      }
      return { role: 'assistant', content };
    }
    // OpenAI/OpenRouter image_url parts → Anthropic image blocks.
    if (Array.isArray(m.content)) {
      return {
        role: m.role,
        content: m.content.map(part => {
          if (part?.type === 'text') return { type: 'text', text: String(part.text || '') };
          if (part?.type === 'image_url') {
            const url = String(part.image_url?.url || '');
            const m64 = url.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (m64) {
              return { type: 'image', source: { type: 'base64', media_type: m64[1], data: m64[2] } };
            }
            return { type: 'image', source: { type: 'url', url } };
          }
          return { type: 'text', text: '' };
        }),
      };
    }
    return m;
  });

  const body = {
    model,
    max_tokens: 8192,
    messages: rest,
    stream: true,
    ...(system ? { system } : {}),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  }
  const wantsThinking = reasoningLevel !== 'none';
  if (wantsThinking) {
    body.thinking = { type: 'enabled', budget_tokens: { low: 2048, medium: 8192, high: 16384 }[reasoningLevel] || 4096 };
  }

  const guard = createStreamGuard(signal);
  try {
    const r = await fetch(`${apiRoot(base)}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: guard.signal,
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
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') {
      await send({
        type: 'tool_delta',
        index: Number(evt.index ?? 0),
        id: evt.content_block.id,
        name: evt.content_block.name,
      });
    } else if (evt.type === 'content_block_delta') {
      if (evt.delta?.type === 'thinking_delta' && evt.delta.thinking) {
        await send({ type: 'reasoning', text: evt.delta.thinking });
      } else if (evt.delta?.type === 'text_delta' && evt.delta.text) {
        await send({ type: 'text', text: evt.delta.text });
      } else if (evt.delta?.type === 'input_json_delta' && evt.delta.partial_json) {
        await send({ type: 'tool_delta', index: Number(evt.index ?? 0), argsDelta: evt.delta.partial_json });
      }
    } else if (evt.type === 'message_delta' && evt.delta?.stop_reason) {
      await send({ type: 'finish', reason: evt.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop' });
      const usage = evt.usage;
      if (usage) {
        const input = Number(usage.input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        await send({ type: 'usage', usage: { input, output, total: input + output } });
      }
    } else if (evt.type === 'message_start' && evt.message?.usage) {
      const usage = evt.message.usage;
      const input = Number(usage.input_tokens ?? 0);
      const output = Number(usage.output_tokens ?? 0);
      if (input || output) {
        await send({ type: 'usage', usage: { input, output, total: input + output } });
      }
    }
  }, () => guard.touch());
  } finally {
    guard.dispose();
  }
}

// Shared SSE frame reader for provider responses. `onData` fires per network
// chunk so callers can keep an idle guard alive.
async function parseSSE(response, onPayload, onData = () => {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onData(value);
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

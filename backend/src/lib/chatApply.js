// Port of ui/src/lib/assistantEngine applyEvent + compaction helpers.
// Kept in JS so the server job loop can persist the same message shape the UI renders.

let seq = 0;
export const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export const COMPACT_AFTER_MESSAGES = 24;

export const COMPACTION_PROMPT = `You are compacting a conversation between a user and the Nixre Assistant so work can continue seamlessly in a fresh context window. Produce a dense handoff summary with exactly these sections:

**Goal** — what the user is trying to accomplish (their intent, not a paraphrase of one message).
**Done** — completed steps, answers and changes so far, with concrete file paths.
**Decisions & facts** — chosen approaches, constraints, error messages, file:line references and command results future turns still need.
**Next** — the precise point where the work stopped and the immediate next step(s).

Rules:
- Preserve every file path, identifier, command and error text that later turns may need verbatim.
- Output ONLY the four sections. No preamble, no commentary, do not answer the user.
- Stay under ~300 words unless truly impossible.`;

export function formatCompactionForPrompt(summary) {
  return `<compacted_context>
The earlier part of this conversation was auto-compacted to fit the context window. Summary of everything before your latest messages:

${summary}

Continue naturally from where things left off. Do not reintroduce yourself or restate the summary.
</compacted_context>`;
}

function lastCompactionIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.kind === 'compaction') return i;
  }
  return -1;
}

const isTurnMessage = (m) =>
  m.role === 'user' || (m.role === 'assistant' && Boolean(m.content));

export function shouldAutoCompact(messages) {
  const start = lastCompactionIndex(messages) + 1;
  return messages.slice(start).filter(isTurnMessage).length >= COMPACT_AFTER_MESSAGES;
}

export function buildModelContext(messages) {
  const start = lastCompactionIndex(messages);
  const entry = start >= 0 ? messages[start] : null;
  const rest = messages.slice(start + 1).filter(isTurnMessage);
  return {
    summary: entry?.summary ?? null,
    history: rest.map(m => ({
      role: m.role,
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
    })),
  };
}

export function withCompaction(messages, summary) {
  return [
    ...messages,
    {
      id: uid('cmp'),
      kind: 'compaction',
      summary,
      coversThroughId: messages[messages.length - 1]?.id ?? '',
      createdAt: Date.now(),
    },
  ];
}

function syncLegacyFields(message) {
  const parts = message.parts ?? [];
  const reasoning = [];
  const toolCalls = [];
  let content = '';
  for (const p of parts) {
    if (p.type === 'reasoning') reasoning.push({ id: p.id, text: p.text });
    else if (p.type === 'tool') toolCalls.push(p.tool);
    else if (p.type === 'text') content += p.text;
  }
  return {
    ...message,
    parts,
    content,
    reasoning: reasoning.length ? reasoning : undefined,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function activeAssistantIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.kind !== 'compaction') return i;
  }
  return -1;
}

function ensureActiveAssistant(messages) {
  const idx = activeAssistantIndex(messages);
  if (idx >= 0) return { messages, idx };
  const msg = {
    id: uid('msg'),
    role: 'assistant',
    content: '',
    parts: [],
    createdAt: Date.now(),
  };
  messages = [...messages, msg];
  return { messages, idx: messages.length - 1 };
}

export function applyEvent(messages, ev) {
  if (ev.type === 'user_message') {
    if (messages.some(m => m.id === ev.message.id)) return messages;
    return [...messages, ev.message];
  }

  if (ev.type === 'step_clear_preamble') {
    const { messages: ms, idx } = ensureActiveAssistant(messages);
    const message = { ...ms[idx] };
    const parts = [...(message.parts ?? [])];
    while (parts.length > 0 && parts[parts.length - 1].type === 'text') parts.pop();
    message.parts = parts;
    const next = ms.slice();
    next[idx] = syncLegacyFields(message);
    return next;
  }

  if (ev.type === 'stream_retry') {
    const { messages: ms, idx } = ensureActiveAssistant(messages);
    const message = { ...ms[idx] };
    const parts = [...(message.parts ?? [])];
    while (parts.length > 0) {
      const last = parts[parts.length - 1];
      // Keep completed tools from previous rounds, but drop any tool that was
      // still 'running' when the stream aborted or failed.
      if (last.type === 'tool' && last.tool?.status !== 'running') break;
      parts.pop();
    }
    message.parts = parts;
    const next = ms.slice();
    next[idx] = syncLegacyFields(message);
    return next;
  }

  if (ev.type === 'steer_applied') {
    return [
      ...messages,
      {
        id: uid('u'),
        role: 'user',
        content: ev.prompt,
        images: ev.images?.length ? ev.images : undefined,
        createdAt: Date.now(),
      },
    ];
  }

  const { messages: ms, idx } = ensureActiveAssistant(messages);
  const message = { ...ms[idx] };
  let parts = [...(message.parts ?? [])];

  switch (ev.type) {
    case 'reasoning': {
      const last = parts[parts.length - 1];
      if (last?.type === 'reasoning' && last.id === ev.blockId) {
        parts[parts.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        parts.push({ type: 'reasoning', id: ev.blockId, text: ev.text });
      }
      break;
    }
    case 'tool_start': {
      const ti = parts.findIndex(p => p.type === 'tool' && p.tool.id === ev.tool.id);
      if (ti >= 0) {
        const part = parts[ti];
        parts[ti] = {
          type: 'tool',
          tool: {
            ...part.tool,
            name: ev.tool.name || part.tool.name,
            argsText: ev.tool.argsText ?? part.tool.argsText,
            status:
              part.tool.status === 'success' || part.tool.status === 'error'
                ? part.tool.status
                : ev.tool.status,
          },
        };
      } else {
        parts.push({ type: 'tool', tool: ev.tool });
      }
      break;
    }
    case 'tool_output':
      parts = parts.map(p => {
        if (p.type !== 'tool' || p.tool.id !== ev.toolId) return p;
        return { type: 'tool', tool: { ...p.tool, status: 'success', output: ev.output } };
      });
      break;
    case 'tool_error':
      parts = parts.map(p => {
        if (p.type !== 'tool' || p.tool.id !== ev.toolId) return p;
        return { type: 'tool', tool: { ...p.tool, status: 'error', output: ev.output } };
      });
      break;
    case 'message_text': {
      const last = parts[parts.length - 1];
      if (last?.type === 'text') {
        parts[parts.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        parts.push({ type: 'text', text: ev.text });
      }
      break;
    }
    default:
      return messages;
  }

  message.parts = parts;
  const next = ms.slice();
  next[idx] = syncLegacyFields(message);
  return next;
}

export function toMultimodalParts(text, images) {
  const parts = [];
  if (text) parts.push({ type: 'text', text });
  for (const img of images || []) {
    if (img.dataUrl) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
  }
  if (parts.length === 0) parts.push({ type: 'text', text: '' });
  return parts;
}

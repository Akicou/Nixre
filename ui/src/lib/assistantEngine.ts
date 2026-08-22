// Nixre Assistant engine.
//
// Two parts:
//   * Conversation persistence - server-backed via nixre-sync (Postgres), so
//     chat sessions follow the account across browsers and devices.
//   * runRealTurn() - streams actual model replies through nixre-core's
//     /ai/chat proxy. A validated AI provider is required; there is no
//     offline or canned-response fallback.

import type { AssistantProviderProfile } from './assistantProfiles';
import type { ChatTurn } from './aiApi';
import * as sync from './syncApi';
import { toMultimodalParts, type ChatImage } from './chatImages';
import { peelTrace, withTrace, type SessionTraceEntry, type TokenUsage } from './sessionTrace';

export type ToolStatus = 'running' | 'success' | 'error';

export interface ToolCall {
  id: string;
  name: string; // tool id, e.g. 'read_file'
  status: ToolStatus;
  argsText?: string; // raw JSON arguments requested by the model
  output?: string; // rendered output for a finished tool
}

export interface ReasoningBlock {
  id: string;
  text: string;
}

/** One visual segment inside an assistant turn — rendered in array order (LibreChat-style). */
export type MessagePart =
  | { type: 'reasoning'; id: string; text: string }
  | { type: 'tool'; tool: ToolCall }
  | { type: 'text'; text: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  images?: ChatImage[];
  /** Chronological segments for this turn (reasoning → tools → answer text). */
  parts?: MessagePart[];
  /** Legacy mirrors — kept in sync for export and older saved chats. */
  toolCalls?: ToolCall[];
  reasoning?: ReasoningBlock[];
  createdAt: number;
}

/** Ordered segments to render; falls back to legacy fields on old conversations. */
export function messageParts(message: ChatMessage): MessagePart[] {
  if (message.parts?.length) return message.parts;
  const parts: MessagePart[] = [];
  for (const r of message.reasoning ?? []) {
    parts.push({ type: 'reasoning', id: r.id, text: r.text });
  }
  for (const t of message.toolCalls ?? []) {
    parts.push({ type: 'tool', tool: t });
  }
  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }
  return parts;
}

function syncLegacyFields(message: ChatMessage): ChatMessage {
  const parts = message.parts ?? [];
  const reasoning: ReasoningBlock[] = [];
  const toolCalls: ToolCall[] = [];
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

export interface Conversation {
  id: string;
  repoPath: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  /** Append-only distillation log (hidden from the chat transcript). */
  trace?: SessionTraceEntry[];
}

// ---------------------------------------------------------------------------
// Auto-compaction — keeps long conversations inside the context window.
//
// A CompactionEntry rides inside conversation.messages (persisted as jsonb).
// Everything before it stays visible in the UI transcript, but only its
// summary + the messages after it are sent to the model on later turns.
// ---------------------------------------------------------------------------

export interface CompactionEntry {
  id: string;
  kind: 'compaction';
  summary: string;
  coversThroughId: string; // last message id included in the summary
  createdAt: number;
}

/** Compact once this many user/assistant turns pile up after the last compaction. */
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

function lastCompactionIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as any)?.kind === 'compaction') return i;
  }
  return -1;
}

const isTurnMessage = (m: ChatMessage) =>
  m.role === 'user' || (m.role === 'assistant' && Boolean(m.content));

/** True when enough un-compacted turns have accumulated to justify compaction. */
export function shouldAutoCompact(messages: ChatMessage[]): boolean {
  const start = lastCompactionIndex(messages) + 1;
  return messages.slice(start).filter(isTurnMessage).length >= COMPACT_AFTER_MESSAGES;
}

/** Build what the model should see: the active summary (if any) + recent turns. */
export function buildModelContext(messages: ChatMessage[]): {
  summary: string | null;
  history: { role: 'user' | 'assistant'; content: string; images?: ChatImage[] }[];
} {
  const start = lastCompactionIndex(messages);
  const entry = start >= 0 ? (messages[start] as unknown as CompactionEntry) : null;
  const rest = messages.slice(start + 1).filter(isTurnMessage);
  return {
    summary: entry?.summary ?? null,
    history: rest.map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      ...(m.images?.length ? { images: m.images } : {}),
    })),
  };
}

/** Wrap a summary as the system message prepended to later turns. */
export function formatCompactionForPrompt(summary: string): string {
  return `<compacted_context>
The earlier part of this conversation was auto-compacted to fit the context window. Summary of everything before your latest messages:

${summary}

Continue naturally from where things left off. Do not reintroduce yourself or restate the summary.
</compacted_context>`;
}

/**
 * Ask the model itself to summarize the un-compacted portion of the chat.
 * Throws on provider failure — callers decide whether to skip compaction.
 */
export async function runCompaction(
  messages: ChatMessage[],
  profile: AssistantProviderProfile,
  overrides: { model?: string } = {},
): Promise<string> {
  const { streamAiChat } = await import('./aiApi');

  const start = lastCompactionIndex(messages) + 1;
  const transcript = messages
    .slice(start)
    .filter(isTurnMessage)
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${m.content.slice(0, 4000)}`)
    .join('\n\n');

  return new Promise<string>((resolve, reject) => {
    let out = '';
    let failed: string | null = null;
    streamAiChat(
      [
        { role: 'system', content: COMPACTION_PROMPT },
        { role: 'user', content: transcript || '(empty conversation)' },
      ],
      { model: overrides.model || profile.model, reasoningLevel: 'none' },
      evt => {
        if (evt.type === 'text') out += evt.text;
        else if (evt.type === 'error') failed = evt.message;
      },
    ).then(
      () => {
        if (failed) reject(new Error(failed));
        else if (!out.trim()) reject(new Error('Compaction returned an empty summary'));
        else resolve(out.trim());
      },
      err => reject(err instanceof Error ? err : new Error('Compaction failed')),
    );
  });
}

/** Append a fresh compaction entry covering everything up to now. */
export function withCompaction(messages: ChatMessage[], summary: string): ChatMessage[] {
  const entry: CompactionEntry = {
    id: uid('cmp'),
    kind: 'compaction',
    summary,
    coversThroughId: messages[messages.length - 1]?.id ?? '',
    createdAt: Date.now(),
  };
  return [...messages, entry as unknown as ChatMessage];
}

export type EngineEvent =
  | { type: 'reasoning'; blockId: string; text: string }
  | { type: 'tool_start'; tool: ToolCall }
  | { type: 'tool_output'; toolId: string; output: string }
  | { type: 'tool_error'; toolId: string; output: string }
  | { type: 'message_text'; text: string }
  /** Drop preamble text streamed before the model commits to tool_calls. */
  | { type: 'step_clear_preamble' }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done'; conversationId?: string; messageId?: string };

/** Safety bound on agent loop iterations per turn. */
export const MAX_AGENT_STEPS = 8;

let seq = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Event reducer — folds a streamed EngineEvent into a message list.
// Shared by every chat surface (repo page, PR panel, dashboard).
// ---------------------------------------------------------------------------

function activeAssistantIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && (m as { kind?: string }).kind !== 'compaction') {
      return i;
    }
  }
  return -1;
}

function ensureActiveAssistant(messages: ChatMessage[]): { messages: ChatMessage[]; idx: number } {
  const idx = activeAssistantIndex(messages);
  if (idx >= 0) return { messages, idx };
  const msg: ChatMessage = {
    id: uid('msg'),
    role: 'assistant',
    content: '',
    parts: [],
    createdAt: Date.now(),
  };
  messages = [...messages, msg];
  return { messages, idx: messages.length - 1 };
}

export function applyEvent(messages: ChatMessage[], ev: EngineEvent): ChatMessage[] {
  if (ev.type === 'step_clear_preamble') {
    const { messages: ms, idx } = ensureActiveAssistant(messages);
    const message = { ...ms[idx] };
    const parts = [...(message.parts ?? [])];
    while (parts.length > 0 && parts[parts.length - 1].type === 'text') {
      parts.pop();
    }
    message.parts = parts;
    const next = ms.slice();
    next[idx] = syncLegacyFields(message);
    return next;
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
        const part = parts[ti] as Extract<MessagePart, { type: 'tool' }>;
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
        return { type: 'tool', tool: { ...p.tool, status: 'success' as const, output: ev.output } };
      });
      break;
    case 'tool_error':
      parts = parts.map(p => {
        if (p.type !== 'tool' || p.tool.id !== ev.toolId) return p;
        return { type: 'tool', tool: { ...p.tool, status: 'error' as const, output: ev.output } };
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

// ---------------------------------------------------------------------------
// Persistence (server-backed via nixre-sync)
// ---------------------------------------------------------------------------

function coerceConversation(c: sync.SyncConversation): Conversation {
  const raw = Array.isArray(c.messages) ? (c.messages as ChatMessage[]) : [];
  const { messages, trace } = peelTrace(raw);
  return {
    id: c.id,
    repoPath: c.repoPath,
    title: c.title,
    messages,
    updatedAt: c.updatedAt,
    trace,
  };
}

export async function listConversations(repoPath?: string): Promise<Conversation[]> {
  const rows = await sync.listConversations(repoPath);
  return rows.map(coerceConversation).sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(id: string): Promise<Conversation | undefined> {
  const row = await sync.getConversation(id);
  return row ? coerceConversation(row) : undefined;
}

export async function createConversation(repoPath: string, title: string): Promise<Conversation> {
  const row = await sync.createConversation(repoPath, title.slice(0, 128));
  return coerceConversation(row);
}

export async function updateConversation(conversation: Conversation): Promise<void> {
  await sync.updateConversation(conversation.id, {
    title: conversation.title,
    messages: withTrace(conversation.messages, conversation.trace ?? []),
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await sync.deleteConversation(id);
}

// ---------------------------------------------------------------------------
// Real turn — streams a model reply through nixre-core's /ai/chat proxy and,
// in agent/debug mode, runs the tool loop: the model requests tools, we
// execute them server-side, feed results back, and let it continue — up to
// MAX_AGENT_STEPS rounds. Provider credentials never leave the server.
// ---------------------------------------------------------------------------

let reasonSeq = 0;

export async function* runRealTurn(
  prompt: string,
  profile: AssistantProviderProfile,
  history: { role: 'user' | 'assistant'; content: string | ChatTurn['content']; images?: ChatImage[] }[],
  overrides: {
    model?: string;
    reasoningLevel?: string;
    mode?: string;
    compactionSummary?: string;
    repoPath?: string;
    conversationId?: string;
    agent?: boolean;
    signal?: AbortSignal;
    extraContext?: string;
    images?: ChatImage[];
  } = {},
): AsyncGenerator<EngineEvent> {
  const aiApi = await import('./aiApi');
  const { getMode } = await import('./assistantModes');

  const mode = getMode(overrides.mode);
  const signal = overrides.signal;
  const useTools = overrides.agent === true && Boolean(overrides.repoPath);

  if (useTools && overrides.repoPath && overrides.conversationId) {
    void aiApi.touchAgentSandbox(overrides.repoPath, overrides.conversationId);
  }

  // The provider-side thread.
  const thread: ChatTurn[] = [
    { role: 'system', content: mode.systemPrompt },
    // Attached working context (e.g. a PR diff) — above history, below the
    // persona so it reads as data, not instructions.
    ...(overrides.extraContext
      ? [{ role: 'system' as const, content: `<attached_context>\n${overrides.extraContext}\n</attached_context>` }]
      : []),
    // The compaction summary rides above the sliced history so it can never
    // be cut off by the window.
    ...(overrides.compactionSummary
      ? [{ role: 'system' as const, content: formatCompactionForPrompt(overrides.compactionSummary) }]
      : []),
    ...history.slice(-20).map(m => {
      if (m.role === 'user' && m.images && m.images.length > 0) {
        return { role: 'user' as const, content: toMultimodalParts(typeof m.content === 'string' ? m.content : '', m.images) };
      }
      return { role: m.role as 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : '' };
    }),
    {
      role: 'user',
      content:
        overrides.images && overrides.images.length > 0
          ? toMultimodalParts(prompt, overrides.images)
          : prompt,
    },
  ];

  let errored: string | null = null;
  let aborted = false;

  yield* (async function* () {
    // Bridge callback-based streams into the generator. `streamStep`
    // resolves when the provider stream ends; live events flow through the
    // queue the whole time.
    const queue: EngineEvent[] = [];
    let resolveNext: (() => void) | null = null;

    const push = (evt: EngineEvent) => {
      queue.push(evt);
      resolveNext?.();
      resolveNext = null;
    };

    const drain = async function* () {
      for (;;) {
        if (queue.length === 0) return;
        yield queue.shift()!;
      }
    };

    // One streaming round: forwards reasoning/text live, accumulates tool
    // calls, and returns them when the model asked for tools.
    const streamStep = (): Promise<{
      calls: { id: string; name: string; args: string }[];
      text: string;
    }> => {
      return new Promise(resolve => {
        const pending = new Map<number, { id?: string; name?: string; args: string }>();
        const started = new Set<string>();
        let stepText = '';
        let stepTextLive = false;
        let roundToolSeen = false;
        let currentBlockId: string | null = null;

        const settle = () => {
          const calls = [...pending.values()]
            .filter(c => c.id && c.name)
            .map(c => ({ id: c.id!, name: c.name!, args: c.args }));
          resolve({ calls, text: stepText });
        };

        aiApi
          .streamAiChat(
            thread,
            {
              model: overrides.model || profile.model,
              reasoningLevel: overrides.reasoningLevel || profile.reasoningLevel,
              tools: useTools,
              signal,
            },
            evt => {
              if (evt.type === 'reasoning') {
                // Interleaved reasoning is a display toggle: when off, drop
                // the thinking deltas... they still stream, we just ignore.
                if (profile.interleavedReasoning) {
                  currentBlockId ||= `reason_${Date.now()}_${reasonSeq++}`;
                  push({ type: 'reasoning', blockId: currentBlockId, text: evt.text });
                }
              } else if (evt.type === 'text') {
                currentBlockId = null;
                stepText += evt.text;
                if (!useTools || !roundToolSeen) {
                  stepTextLive = true;
                  push({ type: 'message_text', text: evt.text });
                }
              } else if (evt.type === 'tool_delta') {
                if (useTools && !roundToolSeen && stepTextLive) {
                  push({ type: 'step_clear_preamble' });
                  stepTextLive = false;
                }
                roundToolSeen = true;
                const cur = pending.get(evt.index) ?? { args: '' };
                if (evt.id) cur.id = evt.id;
                if (evt.name) cur.name = evt.name;
                if (evt.argsDelta) cur.args += evt.argsDelta;
                pending.set(evt.index, cur);
                if (cur.id && cur.name && !started.has(cur.id)) {
                  started.add(cur.id);
                  push({
                    type: 'tool_start',
                    tool: { id: cur.id, name: cur.name, status: 'running', argsText: cur.args },
                  });
                } else if (cur.id && started.has(cur.id) && evt.argsDelta) {
                  push({
                    type: 'tool_start',
                    tool: { id: cur.id, name: cur.name || '', status: 'running', argsText: cur.args },
                  });
                }
              } else if (evt.type === 'usage') {
                push({ type: 'usage', usage: evt.usage });
              } else if (evt.type === 'finish') {
                if (useTools && evt.reason === 'tool_calls') {
                  // Preamble already cleared when the first tool delta arrived.
                } else if (useTools && evt.reason === 'stop' && stepText && !stepTextLive) {
                  push({ type: 'message_text', text: stepText });
                }
              } else if (evt.type === 'error') {
                errored = evt.message;
                settle();
              } else if (evt.type === 'done') {
                settle();
              }
            },
          )
          .catch((err: unknown) => {
            // A rejected fetch (network drop) must not hang the turn; an
            // AbortError is the user pressing Stop, not a failure.
            if (err && (err as Error).name === 'AbortError') {
              aborted = true;
            } else {
              errored = err instanceof Error ? err.message : 'The AI provider request failed.';
            }
            settle();
          });
      });
    };

    for (let step = 0; step < MAX_AGENT_STEPS; step++) {
      const { calls, text } = await streamStep();
      yield* drain();
      if (aborted) return;
      if (errored) return;
      if (!useTools || calls.length === 0) return;

      // Record the assistant's tool request so the next round has context.
      thread.push({
        role: 'assistant',
        content: text,
        tool_calls: calls.map(c => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.args },
        })),
      });

      for (const call of calls) {
        if (signal?.aborted) return;
        let argsObj: Record<string, unknown> = {};
        try {
          argsObj = call.args ? JSON.parse(call.args) : {};
        } catch {
          argsObj = {};
        }
        push({ type: 'tool_start', tool: { id: call.id, name: call.name, status: 'running', argsText: call.args } });
        try {
          const output = await aiApi.executeAssistantTool(overrides.repoPath!, call.name, argsObj, {
            conversationId: overrides.conversationId,
          });
          push({ type: 'tool_output', toolId: call.id, output });
          thread.push({ role: 'tool', tool_call_id: call.id, content: output });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Tool execution failed';
          push({ type: 'tool_error', toolId: call.id, output: msg });
          thread.push({ role: 'tool', tool_call_id: call.id, content: `Error: ${msg}` });
        }
      }
      yield* drain();
      // Loop: the model now sees the tool results and continues.
    }
  })();

  if (errored) {
    throw new Error(errored);
  }
  if (aborted) {
    const err = new Error('Turn stopped');
    err.name = 'AbortError';
    throw err;
  }
}


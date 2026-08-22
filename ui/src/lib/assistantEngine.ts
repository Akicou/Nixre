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

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  reasoning?: ReasoningBlock[];
  createdAt: number;
}

export interface Conversation {
  id: string;
  repoPath: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
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
  history: { role: 'user' | 'assistant'; content: string }[];
} {
  const start = lastCompactionIndex(messages);
  const entry = start >= 0 ? (messages[start] as unknown as CompactionEntry) : null;
  const rest = messages.slice(start + 1).filter(isTurnMessage);
  return {
    summary: entry?.summary ?? null,
    history: rest.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
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
  | { type: 'done'; conversationId?: string; messageId?: string };

/** Safety bound on agent loop iterations per turn. */
export const MAX_AGENT_STEPS = 8;

let seq = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Event reducer — folds a streamed EngineEvent into a message list.
// Shared by every chat surface (repo page, PR panel, dashboard).
// ---------------------------------------------------------------------------

export function applyEvent(messages: ChatMessage[], ev: EngineEvent): ChatMessage[] {
  // Only continue an assistant message that follows the latest user message —
  // otherwise turn N's events would stream into turn N-1's reply.
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant') {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    // No assistant message yet for this turn — create one so the first
    // streamed event (reasoning / tool) has a target to append to.
    const msg: ChatMessage = { id: uid('msg'), role: 'assistant', content: '', createdAt: Date.now() };
    messages = [...messages, msg];
    idx = messages.length - 1;
  }
  const message = { ...messages[idx] };
  switch (ev.type) {
    case 'reasoning': {
      // Deltas with the same blockId belong to one contiguous thinking block —
      // merge them instead of stacking a new fragment per token.
      const blocks = [...(message.reasoning ?? [])];
      const last = blocks[blocks.length - 1];
      if (last && last.id === ev.blockId) {
        blocks[blocks.length - 1] = { ...last, text: last.text + ev.text };
      } else {
        blocks.push({ id: ev.blockId, text: ev.text });
      }
      message.reasoning = blocks;
      break;
    }
    case 'tool_start':
      message.toolCalls = [...(message.toolCalls ?? []), ev.tool];
      break;
    case 'tool_output':
      message.toolCalls = (message.toolCalls ?? []).map(t =>
        t.id === ev.toolId ? { ...t, status: 'success' as const, output: ev.output } : t,
      );
      break;
    case 'tool_error':
      message.toolCalls = (message.toolCalls ?? []).map(t =>
        t.id === ev.toolId ? { ...t, status: 'error' as const, output: ev.output } : t,
      );
      break;
    case 'message_text':
      message.content = (message.content ?? '') + ev.text;
      break;
    default:
      break;
  }
  const next = messages.slice();
  next[idx] = message;
  return next;
}

// ---------------------------------------------------------------------------
// Persistence (server-backed via nixre-sync)
// ---------------------------------------------------------------------------

function coerceConversation(c: sync.SyncConversation): Conversation {
  return {
    id: c.id,
    repoPath: c.repoPath,
    title: c.title,
    messages: Array.isArray(c.messages) ? (c.messages as ChatMessage[]) : [],
    updatedAt: c.updatedAt,
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
    messages: conversation.messages,
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
  history: { role: 'user' | 'assistant'; content: string }[],
  overrides: {
    model?: string;
    reasoningLevel?: string;
    mode?: string;
    compactionSummary?: string;
    repoPath?: string;
    agent?: boolean;
    signal?: AbortSignal;
    extraContext?: string;
  } = {},
): AsyncGenerator<EngineEvent> {
  const aiApi = await import('./aiApi');
  const { getMode } = await import('./assistantModes');

  const mode = getMode(overrides.mode);
  const signal = overrides.signal;
  const useTools = overrides.agent === true && Boolean(overrides.repoPath);

  // The provider-side thread. Tool rounds append to it and re-stream.
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
    ...history.slice(-20),
    { role: 'user', content: prompt },
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
        let stepText = '';
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
                push({ type: 'message_text', text: evt.text });
              } else if (evt.type === 'tool_delta') {
                const cur = pending.get(evt.index) ?? { args: '' };
                if (evt.id) cur.id = evt.id;
                if (evt.name) cur.name = evt.name;
                if (evt.argsDelta) cur.args += evt.argsDelta;
                pending.set(evt.index, cur);
              } else if (evt.type === 'finish') {
                // 'tool_calls' vs 'stop' — the accumulated calls tell us
                // which; nothing to do here.
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
          const output = await aiApi.executeAssistantTool(overrides.repoPath!, call.name, argsObj);
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


// Nixre Assistant engine.
//
// Two parts:
//   * Conversation persistence - server-backed via nixre-sync (Postgres), so
//     chat sessions follow the account across browsers and devices.
//   * runRealTurn() - streams actual model replies through nixre-core's
//     /ai/chat proxy. A validated AI provider is required; there is no
//     offline or canned-response fallback.

import type { AssistantProviderProfile } from './assistantProfiles';
import * as sync from './syncApi';

export type ToolStatus = 'running' | 'success' | 'error';

export interface ToolCall {
  id: string;
  name: string; // tool id, e.g. 'run_tests'
  status: ToolStatus;
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
  | { type: 'message_text'; text: string }
  | { type: 'done'; conversationId?: string; messageId?: string };

let seq = 0;
export const uid = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

// ---------------------------------------------------------------------------
// Event reducer — folds a streamed EngineEvent into a message list.
// Shared by every chat surface (repo page, PR panel, dashboard).
// ---------------------------------------------------------------------------

export function applyEvent(messages: ChatMessage[], ev: EngineEvent): ChatMessage[] {
  let idx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
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
// Real turn — streams an actual model reply through nixre-core's /ai/chat
// proxy. The provider credentials live server-side; this only carries the
// conversation. `history` holds prior user/assistant turns for context.
// ---------------------------------------------------------------------------

let reasonSeq = 0;

export async function* runRealTurn(
  prompt: string,
  profile: AssistantProviderProfile,
  history: { role: 'user' | 'assistant'; content: string }[],
  overrides: { model?: string; reasoningLevel?: string; mode?: string; compactionSummary?: string } = {},
): AsyncGenerator<EngineEvent> {
  const { streamAiChat } = await import('./aiApi');
  const { getMode } = await import('./assistantModes');

  const mode = getMode(overrides.mode);
  const messages = [
    { role: 'system' as const, content: mode.systemPrompt },
    // The compaction summary rides above the sliced history so it can never
    // be cut off by the window.
    ...(overrides.compactionSummary
      ? [{ role: 'system' as const, content: formatCompactionForPrompt(overrides.compactionSummary) }]
      : []),
    ...history.slice(-20),
    { role: 'user' as const, content: prompt },
  ];

  let errored: string | null = null;
  yield* (async function* () {
    // Bridge the callback-based stream into the generator.
    const queue: EngineEvent[] = [];
    let resolveNext: (() => void) | null = null;
    let finished = false;

    const push = (evt: EngineEvent) => {
      queue.push(evt);
      resolveNext?.();
      resolveNext = null;
    };

    // One stable blockId per contiguous thinking segment: reset when answer
    // text arrives so interleaved reasoning renders as separate blocks.
    let currentBlockId: string | null = null;

    const done = streamAiChat(
      messages,
      {
        model: overrides.model || profile.model,
        reasoningLevel: overrides.reasoningLevel || profile.reasoningLevel,
      },
      evt => {
        if (evt.type === 'reasoning') {
          // Interleaved reasoning is a display toggle: when off, drop the
          // thinking deltas... they still stream, we just ignore them.
          if (profile.interleavedReasoning) {
            currentBlockId ||= `reason_${Date.now()}_${reasonSeq++}`;
            push({ type: 'reasoning', blockId: currentBlockId, text: evt.text });
          }
        } else if (evt.type === 'text') {
          currentBlockId = null;
          push({ type: 'message_text', text: evt.text });
        } else if (evt.type === 'error') {
          errored = evt.message;
          finished = true;
          push({ type: 'done' });
        } else if (evt.type === 'done') {
          finished = true;
          push({ type: 'done' });
        }
      },
    );
    // A rejected fetch (network drop, aborted request) used to hang the turn
    // forever because no `done` event ever reached the queue. Surface it.
    done.catch((err: unknown) => {
      errored = err instanceof Error ? err.message : 'The AI provider request failed.';
      finished = true;
      push({ type: 'done' });
    });

    for (;;) {
      if (queue.length === 0) {
        if (finished) break;
        await new Promise<void>(r => (resolveNext = r));
        continue;
      }
      yield queue.shift()!;
    }
    await done.catch(() => {});
  })();

  if (errored) {
    throw new Error(errored);
  }
}


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
    case 'reasoning':
      message.reasoning = [...(message.reasoning ?? []), { id: ev.blockId, text: ev.text }];
      break;
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
  overrides: { model?: string; reasoningLevel?: string; mode?: string } = {},
): AsyncGenerator<EngineEvent> {
  const { streamAiChat } = await import('./aiApi');
  const { getMode } = await import('./assistantModes');

  const mode = getMode(overrides.mode);
  const messages = [
    { role: 'system' as const, content: mode.systemPrompt },
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

    const done = streamAiChat(
      messages,
      {
        model: overrides.model || profile.model,
        reasoningLevel: overrides.reasoningLevel || profile.reasoningLevel,
      },
      evt => {
        if (evt.type === 'reasoning') {
          // Interleaved reasoning is a display toggle: when off, drop the
          // thinking deltas server... they still stream, we just ignore them.
          if (profile.interleavedReasoning) {
            push({ type: 'reasoning', blockId: `reason_${Date.now()}_${reasonSeq++}`, text: evt.text });
          }
        } else if (evt.type === 'text') {
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


import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  applyEvent,
  buildModelContext,
  messageParts,
  COMPACT_AFTER_MESSAGES,
  createConversation,
  listConversations,
  getConversation,
  shouldAutoCompact,
  updateConversation,
  deleteConversation,
  runRealTurn,
  withCompaction,
  type ChatMessage,
} from './assistantEngine';
import { streamAiChat, executeAssistantTool } from './aiApi';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

// Agent-loop double: streamAiChat / executeAssistantTool are mocked per-test.
vi.mock('./aiApi', () => ({
  streamAiChat: vi.fn(),
  executeAssistantTool: vi.fn(),
  touchAgentSandbox: vi.fn(),
}));

const mockedStream = vi.mocked(streamAiChat);
const mockedExec = vi.mocked(executeAssistantTool);

installSyncFetchMock();

beforeEach(() => {
  localStorage.clear();
  syncMockReset();
});

describe('assistantEngine.applyEvent', () => {
  it('creates the assistant message on the first streamed event', () => {
    const messages = [{ id: 'u1', role: 'user' as const, content: 'hi', createdAt: 1 }];
    const next = applyEvent(messages, { type: 'message_text', text: 'Hello' });
    expect(next).toHaveLength(2);
    expect(next[1].role).toBe('assistant');
    expect(next[1].content).toBe('Hello');
  });

  it('appends reasoning and text to the latest assistant message', () => {
    let messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '', parts: [], createdAt: 2 },
    ];
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r1', text: 'thinking…' });
    messages = applyEvent(messages, { type: 'message_text', text: 'Answer' });
    expect(messageParts(messages[1]).map(p => p.type)).toEqual(['reasoning', 'text']);
    expect(messages[1].content).toBe('Answer');
  });

  it('starts a fresh assistant message on a new turn instead of editing the previous reply', () => {
    let messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'first question', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: 'first answer', createdAt: 2 },
      { id: 'u2', role: 'user', content: 'second question', createdAt: 3 },
    ];
    messages = applyEvent(messages, { type: 'message_text', text: 'second answer' });
    expect(messages).toHaveLength(4);
    expect(messages[1].content).toBe('first answer'); // turn 1 untouched
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].content).toBe('second answer');
  });

  it('keeps reasoning, tools, and answer as chronological parts in one assistant turn', () => {
    let messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'run tests', createdAt: 1 }];
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r1', text: 'I should run the suite.' });
    messages = applyEvent(messages, { type: 'message_text', text: 'Let me check.' });
    messages = applyEvent(messages, { type: 'step_clear_preamble' });
    messages = applyEvent(messages, {
      type: 'tool_start',
      tool: { id: 't1', name: 'run_command', status: 'running', argsText: '{"command":"npm test"}' },
    });
    expect(messages).toHaveLength(2);
    const parts = messageParts(messages[1]);
    expect(parts.map(p => p.type)).toEqual(['reasoning', 'tool']);
    expect(parts[0]).toMatchObject({ type: 'reasoning', text: 'I should run the suite.' });
    expect((parts[1] as { tool: { name: string } }).tool.name).toBe('run_command');

    messages = applyEvent(messages, { type: 'tool_output', toolId: 't1', output: 'ok' });
    messages = applyEvent(messages, { type: 'message_text', text: 'All green.' });
    const finalParts = messageParts(messages[1]);
    expect(finalParts.map(p => p.type)).toEqual(['reasoning', 'tool', 'text']);
    expect(messages[1].content).toBe('All green.');
  });

  it('merges reasoning deltas sharing a blockId instead of stacking fragments', () => {
    let messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'hi', createdAt: 1 }];
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r1', text: 'step one. ' });
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r1', text: 'step two.' });
    // New block after answer text starts a separate thinking segment.
    messages = applyEvent(messages, { type: 'message_text', text: 'Answer' });
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r2', text: 'more thinking' });
    expect(messageParts(messages[1]).filter(p => p.type === 'reasoning')).toHaveLength(2);
    expect(messageParts(messages[1])[0]).toEqual({ type: 'reasoning', id: 'r1', text: 'step one. step two.' });
  });

  it('tracks compaction coverage and builds the model context from the summary', () => {
    let messages: ChatMessage[] = [];
    for (let i = 0; i < COMPACT_AFTER_MESSAGES; i++) {
      messages = applyEvent(messages, { type: 'message_text', text: `reply ${i}` });
      messages.push({ id: `u${i}`, role: 'user', content: `q ${i}`, createdAt: i });
    }
    expect(shouldAutoCompact(messages)).toBe(true);

    messages = withCompaction(messages, 'handoff summary');
    expect((messages[messages.length - 1] as any).kind).toBe('compaction');

    // Right after compacting there is nothing new to fold in again.
    expect(shouldAutoCompact(messages)).toBe(false);

    const ctx = buildModelContext(messages);
    expect(ctx.summary).toBe('handoff summary');
    expect(ctx.history).toHaveLength(0);
  });
});

describe('assistantEngine agent loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes requested tools and feeds results back for a second round', async () => {
    // Round 1: model asks to read a file (args arrive in fragments).
    mockedStream.mockImplementationOnce((_messages, _opts, onEvent) => {
      onEvent({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file' });
      onEvent({ type: 'tool_delta', index: 0, argsDelta: '{"path":"src/in' });
      onEvent({ type: 'tool_delta', index: 0, argsDelta: 'dex.ts"}' });
      onEvent({ type: 'finish', reason: 'tool_calls' });
      onEvent({ type: 'done' });
      return Promise.resolve();
    });
    // Round 2: after the tool result, the model answers.
    mockedStream.mockImplementationOnce((_messages, _opts, onEvent) => {
      onEvent({ type: 'text', text: 'The file looks good.' });
      onEvent({ type: 'done' });
      return Promise.resolve();
    });
    mockedExec.mockResolvedValue('export const x = 1;');

    const profile = {
      provider: 'deepseek',
      baseUrl: '',
      model: 'm',
      reasoningLevel: 'none',
      interleavedReasoning: false,
      keyConfigured: true,
      keyMask: null,
      validatedAt: 1,
      models: [],
    };
    const events = [];
    for await (const ev of runRealTurn('check src/index.ts', profile as any, [], {
      mode: 'agent', repoPath: 'acme/website', agent: true,
    })) {
      events.push(ev);
    }

    expect(mockedStream).toHaveBeenCalledTimes(2);
    expect(mockedExec).toHaveBeenCalledWith('acme/website', 'read_file', { path: 'src/index.ts' }, {
      conversationId: undefined,
    });

    // The second round's thread contains the tool result message.
    const secondThread = mockedStream.mock.calls[1][0];
    const toolMsgs = secondThread.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content).toBe('export const x = 1;');
    expect(toolMsgs[0].tool_call_id).toBe('t1');

    // Events surfaced the tool lifecycle.
    expect(events.some(e => e.type === 'tool_start')).toBe(true);
    expect(events.some(e => e.type === 'tool_output' && /export const x/.test(e.output))).toBe(true);
    expect(events.some(e => e.type === 'message_text' && e.text === 'The file looks good.')).toBe(true);
  });

  it('drops preamble text when the model switches to tool_calls in the same round', async () => {
    mockedStream.mockImplementationOnce((_messages, _opts, onEvent) => {
      onEvent({ type: 'text', text: 'Let me read that.' });
      onEvent({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file' });
      onEvent({ type: 'finish', reason: 'tool_calls' });
      onEvent({ type: 'done' });
      return Promise.resolve();
    });
    mockedStream.mockImplementationOnce((_messages, _opts, onEvent) => {
      onEvent({ type: 'text', text: 'Done.' });
      onEvent({ type: 'done' });
      return Promise.resolve();
    });
    mockedExec.mockResolvedValue('file contents');

    const profile = {
      provider: 'custom',
      baseUrl: 'http://vllm:8000/v1',
      model: 'm',
      reasoningLevel: 'medium',
      interleavedReasoning: true,
      keyConfigured: true,
      keyMask: null,
      validatedAt: 1,
      models: [],
    };
    let messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'go', createdAt: 1 }];
    for await (const ev of runRealTurn('go', profile as any, [], {
      mode: 'agent', repoPath: 'acme/website', agent: true,
    })) {
      messages = applyEvent(messages, ev);
    }
    expect(messageParts(messages[1]).map(p => p.type)).toEqual(['tool', 'text']);
    expect(messages[1].content).toBe('Done.');
  });

  it('does not enable tools outside agent mode', async () => {
    mockedStream.mockImplementationOnce((_messages, opts, onEvent) => {
      expect((opts as any).tools).toBeFalsy();
      onEvent({ type: 'text', text: 'hi' });
      onEvent({ type: 'done' });
      return Promise.resolve();
    });
    const profile = { reasoningLevel: 'none', interleavedReasoning: false, model: 'm' } as any;
    for await (const _ev of runRealTurn('q', profile, [], { mode: 'ask', agent: false })) {
      // drain
    }
    expect(mockedStream).toHaveBeenCalledTimes(1);
    expect((mockedStream.mock.calls[0][1] as any).tools).toBeFalsy();
  });
});

describe('assistantEngine persistence', () => {
  it('lists conversations per repo and clears them', async () => {
    const a = await createConversation('acme/website', 'First');
    const b = await createConversation('acme/website', 'Second');
    await createConversation('acme/api', 'Other repo');

    const forRepo = await listConversations('acme/website');
    expect(forRepo.length).toBe(2);
    expect(forRepo.map(c => c.title).sort()).toEqual(['First', 'Second']);
    expect(b.title).toBe('Second');

    expect((await getConversation(a.id))?.title).toBe('First');
    await deleteConversation(a.id);
    expect(await getConversation(a.id)).toBeUndefined();
    expect((await listConversations('acme/website')).length).toBe(1);
  });

  it('updateConversation persists the turn', async () => {
    const conv = await createConversation('acme/website', 'Turn');
    await updateConversation({
      ...conv,
      messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }],
    });
    const fresh = await getConversation(conv.id);
    expect(fresh?.messages).toHaveLength(1);
  });

  it('stores the session trace off the chat transcript', async () => {
    const conv = await createConversation('acme/website', 'Trace');
    await updateConversation({
      ...conv,
      messages: [{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }],
      trace: [
        {
          type: 'model_change',
          id: 'tr_1',
          timestamp: '2026-08-22T18:00:00.000Z',
          provider: 'deepseek',
          modelId: 'deepseek-chat',
        },
      ],
    });
    const fresh = await getConversation(conv.id);
    expect(fresh?.messages).toEqual([{ id: 'm1', role: 'user', content: 'hi', createdAt: 1 }]);
    expect(fresh?.trace).toHaveLength(1);
    expect(fresh?.trace?.[0]).toMatchObject({ type: 'model_change', modelId: 'deepseek-chat' });
  });
});

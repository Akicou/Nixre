import { describe, it, expect, beforeEach } from 'vitest';
import {
  applyEvent,
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  deleteConversation,
  type ChatMessage,
} from './assistantEngine';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

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
      { id: 'a1', role: 'assistant', content: '', createdAt: 2 },
    ];
    messages = applyEvent(messages, { type: 'reasoning', blockId: 'r1', text: 'thinking…' });
    messages = applyEvent(messages, { type: 'message_text', text: 'Answer' });
    expect(messages[1].reasoning).toHaveLength(1);
    expect(messages[1].content).toBe('Answer');
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
});

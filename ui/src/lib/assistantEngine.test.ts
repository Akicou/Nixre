import { describe, it, expect, beforeEach } from 'vitest';
import {
  planTurn,
  createConversation,
  listConversations,
  getConversation,
  updateConversation,
  deleteConversation,
  runTurn,
} from './assistantEngine';
import { defaultProviderProfile } from './assistantProfiles';
import { installSyncFetchMock, syncMockReset } from '../test/syncMock';

installSyncFetchMock();

beforeEach(() => {
  localStorage.clear();
  syncMockReset();
});

const profile = () => defaultProviderProfile();

describe('assistantEngine.planTurn', () => {
  it('routes a test prompt to the run_tests tool', () => {
    const events = planTurn('run the tests', profile());
    const toolStarts = events.filter(e => e.type === 'tool_start');
    expect(toolStarts.length).toBe(1);
    expect((toolStarts[0] as any).tool.name).toBe('run_tests');
  });

  it('routes a bug prompt to file_read + bash', () => {
    const events = planTurn('fix the failing bug', profile());
    const names = events
      .filter(e => e.type === 'tool_start')
      .map(e => (e as any).tool.name);
    expect(names).toContain('file_read');
    expect(names).toContain('bash');
  });

  it('emits reasoning blocks only when interleaved reasoning is on', () => {
    const off = planTurn('review the PR', { ...profile(), interleavedReasoning: false });
    const on = planTurn('review the PR', { ...profile(), interleavedReasoning: true, reasoningLevel: 'high' });
    expect(off.filter(e => e.type === 'reasoning').length).toBe(0);
    expect(on.filter(e => e.type === 'reasoning').length).toBe(3);
  });

  it('always ends with a message_text event', () => {
    const events = planTurn('anything', profile());
    const last = events[events.length - 1];
    expect(last.type).toBe('done');
    expect(events.some(e => e.type === 'message_text')).toBe(true);
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

  it('runTurn streams events and updateConversation persists the turn', async () => {
    const conv = await createConversation('acme/website', 'Turn');
    const events = [];
    for await (const event of runTurn('run the tests', profile(), 0)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].type).toBe('done');

    await updateConversation({ ...conv, messages: [] });
    expect(await getConversation(conv.id)).toBeDefined();
  });
});

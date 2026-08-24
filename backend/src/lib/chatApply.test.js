import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, shouldAutoCompact, withCompaction, COMPACT_AFTER_MESSAGES } from './chatApply.js';

describe('chatApply', () => {
  it('appends a user message once', () => {
    const msg = { id: 'u1', role: 'user', content: 'hi', createdAt: 1 };
    let messages = applyEvent([], { type: 'user_message', message: msg });
    messages = applyEvent(messages, { type: 'user_message', message: msg });
    assert.equal(messages.length, 1);
  });

  it('records tools then text on the assistant turn', () => {
    let messages = [{ id: 'u1', role: 'user', content: 'go', createdAt: 1 }];
    messages = applyEvent(messages, {
      type: 'tool_start',
      tool: { id: 't1', name: 'read_file', status: 'running', argsText: '{}' },
    });
    messages = applyEvent(messages, { type: 'tool_output', toolId: 't1', output: 'ok' });
    messages = applyEvent(messages, { type: 'message_text', text: 'done' });
    assert.equal(messages[1].content, 'done');
    assert.equal(messages[1].parts[0].tool.status, 'success');
  });

  it('compacts after enough turns', () => {
    let messages = [];
    for (let i = 0; i < COMPACT_AFTER_MESSAGES; i++) {
      messages.push({ id: `u${i}`, role: 'user', content: `q${i}`, createdAt: i });
      messages = applyEvent(messages, { type: 'message_text', text: `a${i}` });
    }
    assert.equal(shouldAutoCompact(messages), true);
    messages = withCompaction(messages, 'summary');
    assert.equal(shouldAutoCompact(messages), false);
  });
});

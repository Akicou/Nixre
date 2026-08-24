import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAgentLoop } from './agentLoop.js';

describe('agentLoop', () => {
  it('executes tools and continues with a second stream round', async () => {
    let round = 0;
    const streamChat = async (_opts, send) => {
      round++;
      if (round === 1) {
        await send({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file' });
        await send({ type: 'tool_delta', index: 0, argsDelta: '{"path":"a.ts"}' });
        await send({ type: 'finish', reason: 'tool_calls' });
        return;
      }
      await send({ type: 'text', text: 'looks good' });
    };
    const executeTool = async (name, args) => {
      assert.equal(name, 'read_file');
      assert.equal(args.path, 'a.ts');
      return 'export const x = 1';
    };
    const events = [];
    await runAgentLoop(
      {
        systemPrompt: 'test',
        history: [],
        prompt: 'check a.ts',
        provider: 'deepseek',
        apiKey: 'k',
        model: 'm',
        tools: [{ name: 'read_file' }],
      },
      ev => events.push(ev),
      { streamChat, executeTool },
    );
    assert.equal(round, 2);
    assert.ok(events.some(e => e.type === 'tool_start' && e.tool.name === 'read_file'));
    assert.ok(events.some(e => e.type === 'tool_output' && e.output === 'export const x = 1'));
    assert.ok(events.some(e => e.type === 'message_text' && e.text === 'looks good'));
  });

  it('injects a steer after the tool round', async () => {
    let round = 0;
    const streamChat = async (_opts, send) => {
      round++;
      if (round === 1) {
        await send({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file' });
        await send({ type: 'tool_delta', index: 0, argsDelta: '{}' });
        return;
      }
      await send({ type: 'text', text: 'redirected' });
    };
    const events = [];
    await runAgentLoop(
      {
        systemPrompt: 'test',
        history: [],
        prompt: 'go',
        provider: 'deepseek',
        apiKey: 'k',
        model: 'm',
        tools: [{ name: 'read_file' }],
      },
      ev => events.push(ev),
      {
        streamChat,
        executeTool: async () => 'ok',
        steerNext: async () => ({ text: 'do this instead' }),
      },
    );
    assert.ok(events.some(e => e.type === 'steer_applied' && e.prompt === 'do this instead'));
    assert.ok(events.some(e => e.type === 'message_text' && e.text === 'redirected'));
  });
});

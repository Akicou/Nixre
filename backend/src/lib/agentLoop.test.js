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

  it('attaches show_images output multimodally and strips base64 from tool text', async () => {
    let secondRoundMessages = null;
    let round = 0;
    const streamChat = async (opts, send) => {
      round++;
      if (round === 1) {
        await send({ type: 'tool_delta', index: 0, id: 't_img', name: 'show_images' });
        await send({ type: 'tool_delta', index: 0, argsDelta: '{"paths":["test.png"]}' });
        await send({ type: 'finish', reason: 'tool_calls' });
        return;
      }
      secondRoundMessages = opts.messages;
      await send({ type: 'text', text: 'I see the image.' });
    };

    const dummyBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const executeTool = async (name) => {
      assert.equal(name, 'show_images');
      return JSON.stringify({
        images: [{ path: 'test.png', mime: 'image/png', source: 'sandbox', dataUrl: dummyBase64 }],
        note: undefined,
      });
    };

    const events = [];
    await runAgentLoop(
      {
        systemPrompt: 'test',
        history: [],
        prompt: 'show me test.png',
        provider: 'openrouter',
        apiKey: 'k',
        model: 'm',
        tools: [{ name: 'show_images' }],
      },
      ev => events.push(ev),
      { streamChat, executeTool },
    );

    assert.equal(round, 2);
    // UI gets full payload with dataUrl
    const outputEv = events.find(e => e.type === 'tool_output');
    assert.ok(outputEv);
    assert.ok(outputEv.output.includes(dummyBase64));

    // Upstream messages thread: tool message must NOT have base64
    const toolMsg = secondRoundMessages.find(m => m.role === 'tool');
    assert.ok(toolMsg);
    assert.ok(!toolMsg.content.includes(dummyBase64));
    assert.ok(toolMsg.content.includes('test.png'));

    // Upstream messages thread: user message attached with image_url
    const userImgMsg = secondRoundMessages.find(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(c => c.type === 'image_url'));
    assert.ok(userImgMsg);
    assert.equal(userImgMsg.content[1].type, 'image_url');
    assert.equal(userImgMsg.content[1].image_url.url, dummyBase64);
  });
});

const loopOptions = { systemPrompt: 'test', prompt: 'go', provider: 'test', model: 'test', tools: [{ name: 'read_file' }] };

it('does not contact the provider after cancellation', async () => {
  const abort = new AbortController();
  abort.abort();
  let requests = 0;
  await assert.rejects(runAgentLoop({ ...loopOptions, signal: abort.signal }, () => {}, {
    streamChat: async () => { requests++; }, executeTool: async () => 'ok',
  }), { name: 'AbortError' });
  assert.equal(requests, 0);
});

for (const args of ['{"path":', 'null', '[]', '"file"']) {
  it(`never executes malformed tool arguments: ${args}`, async () => {
    let executions = 0;
    let requests = 0;
    await assert.rejects(runAgentLoop(loopOptions, () => {}, {
      streamChat: async (_opts, send) => {
        requests++;
        await send({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file', argsDelta: args });
      },
      executeTool: async () => { executions++; return 'ok'; },
    }), /invalid tool arguments.*4 attempts/);
    assert.equal(executions, 0);
    assert.equal(requests, 4);
  });
}

it('retries the entire batch if even one tool call is incomplete', async () => {
  let executions = 0;
  await assert.rejects(runAgentLoop(loopOptions, () => {}, {
    streamChat: async (_opts, send) => {
      await send({ type: 'tool_delta', index: 0, id: 't1', name: 'read_file', argsDelta: '{}' });
      await send({ type: 'tool_delta', index: 1, id: 't2', argsDelta: '{}' });
    },
    executeTool: async () => { executions++; return 'ok'; },
  }), /incomplete tool call/);
  assert.equal(executions, 0);
});

it('keeps every tool reply before attached image messages in a multi-tool batch', async () => {
  let round = 0;
  await runAgentLoop(loopOptions, () => {}, {
    streamChat: async (opts, send) => {
      if (++round === 1) {
        await send({ type: 'tool_delta', index: 0, id: 'image', name: 'show_images', argsDelta: '{}' });
        await send({ type: 'tool_delta', index: 1, id: 'file', name: 'read_file', argsDelta: '{}' });
      } else {
        assert.deepEqual(opts.messages.slice(2).map(m => m.role), ['assistant', 'tool', 'tool', 'user']);
      }
    },
    executeTool: async name => name === 'show_images'
      ? JSON.stringify({ images: [{ path: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }] }) : 'ok',
  });
});

it('accounts for cumulative usage once per stream and saves the provider thread before tools', async () => {
  const deltas = [], snapshots = [];
  let round = 0;
  await runAgentLoop(loopOptions, () => {}, {
    streamChat: async (_opts, send) => {
      if (++round === 1) {
        await send({ type: 'usage', usage: { input: 10, output: 1 } });
        await send({ type: 'usage', usage: { input: 10, output: 5 } });
        await send({ type: 'tool_delta', index: 0, id: 't', name: 'read_file', argsDelta: '{}' });
      }
    },
    onUsage: async usage => { deltas.push(usage); },
    saveThread: async thread => { snapshots.push(structuredClone(thread)); },
    executeTool: async (_name, _args, meta) => {
      assert.equal(meta.callId, 't');
      assert.equal(snapshots.at(-1).at(-1).tool_calls[0].id, 't');
      return 'ok';
    },
  });
  assert.deepEqual(deltas, [{ input: 10, output: 1 }, { input: 0, output: 4 }]);
  assert.equal(snapshots.at(-1).at(-1).role, 'tool');
});

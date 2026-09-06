import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { getEventListeners, once } from 'node:events';
import { listModels, streamChat, encryptSecret } from '../lib/ai.js';
import { transcribeAudio } from '../lib/stt.js';
import { pool } from '../db/pool.js';

async function provider(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const old = process.env.NIXRE_AI_PRIVATE_ORIGINS;
  process.env.NIXRE_AI_PRIVATE_ORIGINS = origin;
  t.after(() => {
    if (old === undefined) delete process.env.NIXRE_AI_PRIVATE_ORIGINS;
    else process.env.NIXRE_AI_PRIVATE_ORIGINS = old;
  });
  return origin;
}

test('model and chat transports reject persisted private endpoints unless explicitly allowlisted', async t => {
  let calls = 0;
  const origin = await provider(t, (_req, res) => { calls++; res.end('{}'); });
  process.env.NIXRE_AI_PRIVATE_ORIGINS = '';
  await assert.rejects(listModels('ollama', null, origin), { code: 'ERR_NET_POLICY' });
  for (const name of ['ollama', 'anthropic']) {
    await assert.rejects(streamChat({
      provider: name, baseUrl: origin, apiKey: 'key', model: 'test',
      messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'none',
    }, async () => {}), { code: 'ERR_NET_POLICY' });
  }
  assert.equal(calls, 0);
});

test('allowlisted local model discovery and both streaming protocols still work', async t => {
  const requests = [];
  const origin = await provider(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, headers: req.headers, body });
    if (req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'local-model' }] }));
      return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    const event = req.url === '/v1/messages'
      ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
      : { choices: [{ delta: { content: 'hello' } }] };
    res.end(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  });
  assert.deepEqual(await listModels('ollama', null, origin), ['local-model']);
  for (const name of ['ollama', 'anthropic']) {
    const events = [];
    await streamChat({
      provider: name, baseUrl: origin, apiKey: 'test-key', model: 'local-model',
      messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'none',
    }, async event => events.push(event));
    assert.ok(events.some(event => event.type === 'text' && event.text === 'hello'), JSON.stringify(events));
  }
  assert.equal(requests[1].headers.authorization, 'Bearer test-key');
  assert.equal(requests[2].headers['x-api-key'], 'test-key');
  assert.equal(JSON.parse(requests[1].body).stream, true);
});

test('caller cancellation remains effective after provider streaming headers arrive', async t => {
  const origin = await provider(t, (req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'text/event-stream');
    res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
  });
  const controller = new AbortController();
  await assert.rejects(streamChat({
    provider: 'ollama', baseUrl: origin, model: 'test',
    messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'none', signal: controller.signal,
  }, async event => {
    if (event.type === 'text') controller.abort(new Error('cancelled by caller'));
  }), /cancelled by caller/);
});

test('send failure cancels unfinished provider streams without unhandled rejections', async t => {
  let socket;
  const origin = await provider(t, (req, res) => {
    socket = req.socket;
    req.resume();
    res.setHeader('Content-Type', 'text/event-stream');
    const event = req.url === '/v1/messages'
      ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'first' } }
      : { choices: [{ delta: { content: 'first' } }] };
    // Do not end the response: cleanup must cancel, not wait for provider EOF.
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  for (const name of ['ollama', 'anthropic']) {
    const failure = new Error(`send failed: ${name}`);
    await assert.rejects(streamChat({
      provider: name, baseUrl: origin, apiKey: 'key', model: 'test',
      messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'none',
    }, () => { throw failure; }), error => error === failure);
    if (!socket.destroyed) {
      await once(socket, 'close', { signal: AbortSignal.timeout(2000) });
    }
    assert.equal(socket.destroyed, true, `${name}: upstream socket must close`);
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('reused caller signal retains no per-request abort listeners after success or failure', async t => {
  const origin = await provider(t, (req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'text/event-stream');
    const event = req.url === '/v1/messages'
      ? { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }
      : { choices: [{ delta: { content: 'hello' } }] };
    res.end(`data: ${JSON.stringify(event)}\n\n`);
  });
  const controller = new AbortController();
  const existingListener = () => {};
  controller.signal.addEventListener('abort', existingListener);
  for (let i = 0; i < 16; i++) {
    const fail = i % 4 >= 2;
    const failure = new Error('consumer rejected');
    const run = streamChat({
      provider: i % 2 ? 'anthropic' : 'ollama', baseUrl: origin, apiKey: 'key', model: 'test',
      messages: [{ role: 'user', content: 'hi' }], reasoningLevel: 'none', signal: controller.signal,
    }, async () => { if (fail) throw failure; });
    if (fail) await assert.rejects(run, error => error === failure);
    else await run;
    assert.deepEqual(getEventListeners(controller.signal, 'abort'), [existingListener], `request ${i}`);
  }
  controller.abort();
});

test('an AI private-origin exception does not permit a redirect to another endpoint', async t => {
  const origin = await provider(t, (_req, res) => {
    res.writeHead(302, { Location: 'http://127.0.0.1:9/v1/models' });
    res.end();
  });
  await assert.rejects(listModels('ollama', null, origin), { code: 'ERR_NET_POLICY' });
});

test('STT validates the stored endpoint at send time and preserves multipart uploads', async t => {
  let request;
  const origin = await provider(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    request = { path: req.url, headers: req.headers, body };
    res.setHeader('Content-Type', 'application/json');
    res.end('{"text":"transcript"}');
  });
  const oldSecret = process.env.AI_SECRET;
  process.env.AI_SECRET = 'transport-test-secret-at-least-32-characters';
  t.after(() => { if (oldSecret === undefined) delete process.env.AI_SECRET; else process.env.AI_SECRET = oldSecret; });
  t.mock.method(pool, 'query', async () => ({ rows: [{
    base_url: origin, model: 'whisper', api_key_enc: encryptSecret('stt-key'),
  }] }));
  const audio = { audioB64: Buffer.from('audio bytes').toString('base64'), format: 'webm' };
  process.env.NIXRE_AI_PRIVATE_ORIGINS = '';
  await assert.rejects(transcribeAudio('dev', audio), { code: 'ERR_NET_POLICY' });
  assert.equal(request, undefined);
  process.env.NIXRE_AI_PRIVATE_ORIGINS = origin;
  assert.deepEqual(await transcribeAudio('dev', audio), { text: 'transcript' });
  assert.equal(request.path, '/v1/audio/transcriptions');
  assert.equal(request.headers.authorization, 'Bearer stt-key');
  assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
  assert.match(request.body, /audio bytes/);
});

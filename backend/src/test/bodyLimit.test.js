// Exercise production middleware, including its error handler, not a copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createApp, createRequestMiddleware, requestErrorHandler } from '../server.js';
import { securityHeaders } from '../lib/securityHeaders.js';

function buildApp({ authenticated = true } = {}) {
  const app = express();
  app.use(securityHeaders);
  app.use(['/api/v1', '/api/sync/v1'], createRequestMiddleware(() => (_req, res, next) =>
    authenticated ? next() : res.status(401).json({ message: 'Authentication required' })));
  app.post('/api/v1/login', (req, res) => res.json({ ok: true, hasBody: Boolean(req.body) }));
  app.use((req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.use(requestErrorHandler);
  return app;
}

function post(app, path, obj, method = 'POST') {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
      const req = http.request(
        {
          port: server.address().port,
          path,
          method,
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        r => {
          let text = '';
          r.on('data', d => (text += d));
          r.on('end', () => {
            server.close();
            resolve({ status: r.statusCode, body: text, headers: r.headers });
          });
        },
      );
      req.on('error', err => {
        server.close();
        resolve({ status: 0, body: String(err.message) });
      });
      req.write(body);
      req.end();
    });
  });
}

test('/ai/chat accepts a payload larger than 1 MB', async () => {
  const app = buildApp();
  // ~2 MB of base64 image data.
  const big = { messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] };
  const res = await post(app, '/api/v1/ai/chat', big);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
  assert.ok(JSON.parse(res.body).bytes > 2 * 1024 * 1024);
});

test('the sync alias gets the same larger limit', async () => {
  const app = buildApp();
  const big = { messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] };
  const res = await post(app, '/api/sync/v1/ai/chat', big);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
});

test('/ai/jobs accepts image-bearing payloads', async () => {
  // Regression: this endpoint takes `images` as base64 data URLs (up to
  // MAX_IMAGE_URL each), but was capped at 1 MB when the global parser was
  // added — every multimodal agent job would have failed with 413.
  const app = buildApp();
  const big = {
    prompt: 'look at this',
    images: [{ mime: 'image/png', data: 'A'.repeat(3 * 1024 * 1024) }],
  };
  const res = await post(app, '/api/v1/ai/jobs', big);
  assert.equal(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
});

test('/ai/tools accepts large file payloads', async () => {
  const app = buildApp();
  const big = { tool: 'write_file', args: { path: 'a.txt', content: 'x'.repeat(2 * 1024 * 1024) } };
  const res = await post(app, '/api/v1/ai/tools', big);
  assert.equal(res.status, 200, `expected 200, got ${res.status}`);
});

test('other endpoints reject bodies over 1 MB', async () => {
  const app = buildApp();
  const big = { login_identifier: 'u', password: 'y'.repeat(2 * 1024 * 1024) };
  const res = await post(app, '/api/v1/login', big);
  assert.equal(res.status, 413, 'ordinary endpoints must stay capped at 1 MB');
});

test('ordinary endpoints still parse small bodies', async () => {
  const app = buildApp();
  const res = await post(app, '/api/v1/login', { login_identifier: 'u', password: 'p' });
  assert.equal(res.status, 200, res.body);
  assert.equal(JSON.parse(res.body).hasBody, true);
  assert.match(res.headers['permissions-policy'], /microphone=\(self\)/);
  assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'");
});

test('all production routers construct without starting boot services', () => {
  const pool = { query() { throw new Error('Construction must not query the database'); } };
  assert.doesNotThrow(() => createApp({ pool }));
});

test('avatars, audio, transcripts and commits retain bounded large payload support', async () => {
  const app = buildApp();
  const cases = [
    ['/api/v1/user/avatar', { mime: 'image/png', data: Buffer.alloc(2 * 1024 * 1024).toString('base64') }],
    ['/api/v1/spaces/acme/avatar', { mime: 'image/png', data: Buffer.alloc(2 * 1024 * 1024).toString('base64') }],
    ['/api/v1/ai/transcribe', { format: 'webm', audio: Buffer.alloc(8 * 1024 * 1024).toString('base64') }],
    ['/api/v1/conversations', { messages: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }],
    ['/api/v1/conversations/123', { messages: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }, 'PUT'],
    ['/api/sync/v1/conversations/123', { messages: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }, 'PUT'],
    ['/api/v1/repos/acme/repo/+/commits', { files: [{ content: 'x'.repeat(2 * 1024 * 1024) }] }],
    ['/api/v1/ai/jobs/123/queue', { images: [{ data: 'x'.repeat(2 * 1024 * 1024) }] }],
  ];
  for (const [path, body, method] of cases) {
    const response = await post(app, path, body, method);
    assert.equal(response.status, 200, `${path}: ${response.body}`);
  }
});

test('production error handler preserves 413 at each body-size boundary', async () => {
  for (const [path, size] of [
    ['/api/v1/login', 17 * 1024],
    ['/api/v1/unknown', 2 * 1024 * 1024],
    ['/api/v1/user/avatar', 4 * 1024 * 1024],
    ['/api/v1/ai/transcribe', 13 * 1024 * 1024],
    ['/api/v1/ai/chat', 65 * 1024 * 1024],
  ]) {
    const response = await post(buildApp(), path, { data: 'x'.repeat(size) });
    assert.equal(response.status, 413, path);
    assert.equal(JSON.parse(response.body).message, 'Request body is too large');
  }
});

test('large bodies require authentication before parsing', async () => {
  const response = await post(buildApp({ authenticated: false }), '/api/v1/ai/chat', { data: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(response.status, 401);
});

test('case and trailing slash variants cannot bypass limits; limiting precedes parsing', async () => {
  const app = buildApp();
  for (let i = 0; i < 10; i++) {
    assert.equal((await post(app, '/api/v1/login', {})).status, 200);
  }
  for (const path of ['/api/v1/login', '/api/v1/login/', '/api/v1/LOGIN', '/api/v1/LOGIN/']) {
    assert.equal((await post(app, path, { data: 'x'.repeat(32 * 1024) })).status, 429, path);
  }
  assert.equal((await post(app, '/api/v1/register', {})).status, 200, 'registration has an independent budget');
});

test('malformed JSON is a 400, not a 500', async () => {
  const res = await post(buildApp(), '/api/v1/login', '{broken-json');
  assert.equal(res.status, 400);
  assert.equal(JSON.parse(res.body).message, 'Invalid JSON body');
});

test('registration, passkeys, tools and all deployment triggers enforce their route budgets', async () => {
  for (const [path, variant, max] of [
    ['/register', '/REGISTER/', 5],
    ['/webauthn/login-challenge', '/WEBAUTHN/LOGIN/', 20],
    ['/ai/tools', '/AI/TOOLS/', 120],
    ['/repos/acme/repo/+/deployments/services/1/deploy', '/repos/acme/repo/+/deployments/services/1/deploy/', 30],
    ['/repos/acme/repo/+/deployments/services/1/deployments/2/redeploy', '/repos/acme/repo/+/deployments/services/1/deployments/2/rollback/', 30],
  ]) {
    const app = buildApp();
    for (let i = 0; i < max; i++) {
      assert.equal((await post(app, `/api/v1${path}`, {})).status, 200, path);
    }
    assert.equal((await post(app, `/api/v1${variant}`, {})).status, 429, variant);
  }
});

test('untrusted forwarded headers are ignored, trusted peers preserve distinct clients', async t => {
  const old = process.env.TRUSTED_PROXY_CIDRS;
  t.after(() => { if (old === undefined) delete process.env.TRUSTED_PROXY_CIDRS; else process.env.TRUSTED_PROXY_CIDRS = old; });
  for (const [trusted, sameClient] of [['', true], ['127.0.0.1/32', false]]) {
    process.env.TRUSTED_PROXY_CIDRS = trusted;
    const app = createApp({ pool: {}, authenticate: () => (_req, _res, next) => next() });
    // Probe Express's configured trust through a route that bypasses DB handlers.
    app.get('/identity', (req, res) => res.json({ ip: req.ip }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/identity`;
      const a = await (await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.10' } })).json();
      const b = await (await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.11' } })).json();
      assert.equal(a.ip === b.ip, sameClient);
      if (trusted) assert.equal(a.ip, '198.51.100.10');
    } finally { await new Promise(resolve => server.close(resolve)); }
  }
});

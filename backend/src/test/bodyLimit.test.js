// Body-size policy: /ai/chat must accept large (image-bearing) payloads while
// every other endpoint stays capped at 1 MB.
//
// Regression guard for a subtle ordering bug: if the global 1 MB parser runs
// first, it rejects an oversized /ai/chat body with 413 before the 64 MB
// parser registered for that path ever sees it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

// Mirrors the middleware block in src/server.js exactly.
const LARGE_BODY_SUFFIXES = ['/ai/chat', '/ai/jobs', '/ai/tools'];

function buildApp() {
  const app = express();
  const json1mb = express.json({ limit: '1mb' });
  for (const suffix of LARGE_BODY_SUFFIXES) {
    app.use(`/api/v1${suffix}`, express.json({ limit: '64mb' }));
    app.use(`/api/sync/v1${suffix}`, express.json({ limit: '64mb' }));
  }
  app.use((req, res, next) => {
    if (LARGE_BODY_SUFFIXES.some(s => req.path.endsWith(s))) return next();
    return json1mb(req, res, next);
  });
  app.post('/api/v1/ai/chat', (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.post('/api/v1/ai/jobs', (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.post('/api/v1/ai/tools', (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.post('/api/sync/v1/ai/chat', (req, res) => res.json({ bytes: JSON.stringify(req.body).length }));
  app.post('/api/v1/login', (req, res) => res.json({ ok: true, hasBody: Boolean(req.body) }));
  return app;
}

function post(app, path, obj) {
  return new Promise(resolve => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const body = JSON.stringify(obj);
      const req = http.request(
        {
          port: server.address().port,
          path,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        },
        r => {
          let text = '';
          r.on('data', d => (text += d));
          r.on('end', () => {
            server.close();
            resolve({ status: r.statusCode, body: text });
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
});

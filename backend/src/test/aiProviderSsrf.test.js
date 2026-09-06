// AI provider endpoints are attacker-controlled URLs that core will fetch.
//
// Regression: the SSRF guard on `baseUrl` was added in a batch where a sibling
// edit failed, so it silently never landed. It is easy to lose again, hence a
// functional test rather than a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { aiRoutes } from '../routes/ai.js';

function stubPool() {
  return {
    async query(sql) {
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: 0 }] };
      return { rows: [] };
    },
    async connect() {
      return { query: async () => ({ rows: [] }), release() {} };
    },
  };
}

function start(pool) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'session', user: { uid: 'dev', admin: false } };
    next();
  });
  app.use('/api/v1', aiRoutes(pool, () => (_req, _res, next) => next()));
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, () => {
      const post = (body, path = '/api/v1/ai/providers', method = 'POST') =>
        new Promise(res => {
          const payload = JSON.stringify(body);
          const req = http.request(
            {
              port: server.address().port,
              path,
              method,
              headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
            },
            r => {
              let text = '';
              r.on('data', d => (text += d));
              r.on('end', () => {
                let json = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  /* ignore */
                }
                res({ status: r.statusCode, json, body: text });
              });
            },
          );
          req.write(payload);
          req.end();
        });
      resolve({ server, post });
    });
  });
}

const BAD_URLS = [
  'http://127.0.0.1:3002/v1',
  'http://localhost:3002/v1',
  'http://169.254.169.254/latest/meta-data',
  'http://nixre-db:5432/',
  'http://[::1]:3002/v1',
  'http://user:pass@example.com/v1',
];

test('creating a provider rejects internal base URLs', async () => {
  const { server, post } = await start(stubPool());
  try {
    for (const baseUrl of BAD_URLS) {
      const res = await post({ provider: 'custom', label: 'x', baseUrl, apiKey: 'sk-test' });
      assert.equal(res.status, 400, `${baseUrl} should be rejected (got ${res.status}: ${res.body})`);
      assert.match(
        res.json?.message ?? '',
        /rejected|Refusing|credentials|private|loopback/i,
        `unexpected message for ${baseUrl}: ${res.json?.message}`,
      );
    }
  } finally {
    server.close();
  }
});

test('legacy profile creation rejects private endpoints before validation or saving', async () => {
  const { server, post } = await start(stubPool());
  try {
    const response = await post({ provider: 'custom', baseUrl: 'http://127.0.0.1:3002/v1', apiKey: 'test' }, '/api/v1/ai/profile', 'PUT');
    assert.equal(response.status, 400, response.body);
    assert.match(response.json.message, /rejected/);
  } finally { server.close(); }
});

test('sandbox touch rechecks current workspace permissions before touching Docker', async () => {
  const { server, post } = await start(stubPool());
  try {
    const response = await post({ repoPath: 'acme/private', conversationId: '123' }, '/api/v1/ai/sandbox/touch');
    assert.ok([403, 404].includes(response.status), response.body);
    assert.match(response.json.message, /repository|account|user/i);
  } finally { server.close(); }
});

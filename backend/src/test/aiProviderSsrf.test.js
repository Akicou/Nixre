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
import { encryptSecret, decryptSecret } from '../lib/ai.js';

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

test('provider edits validate before saving, rotate keys, and preserve compatible selections', async t => {
  const previousPolicy = process.env.NIXRE_AI_PRIVATE_ORIGINS;
  const previousSecret = process.env.AI_SECRET;
  process.env.AI_SECRET = 'provider-edit-test-secret-material-123456789';
  let authorization;
  let reject = false;
  const upstream = http.createServer((req, res) => {
    authorization = req.headers.authorization;
    res.writeHead(reject ? 401 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'keep' }, { id: 'new' }] }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${upstream.address().port}`;
  process.env.NIXRE_AI_PRIVATE_ORIGINS = baseUrl;
  let row = {
    id: 7, user_uid: 'dev', label: 'Existing', provider: 'custom', base_url: `${baseUrl}/old`,
    api_key_enc: encryptSecret('old-test-key'), key_mask: 'old-mask', validated_at: 1,
    default_model: 'keep', enabled_models: ['keep', 'removed'], model_cache: ['keep', 'removed'],
    model_cache_at: 1, is_default: true, created: 1, updated: 1,
  };
  let writes = 0;
  const { server, post } = await start({
    async query(sql, args) {
      if (sql.startsWith('SELECT * FROM ai_providers')) return { rows: [row] };
      if (sql.includes('UPDATE ai_providers SET')) {
        writes++;
        const [, label, base_url, api_key_enc, key_mask, validated_at, default_model, enabled, is_default, updated, models, model_cache_at] = args;
        row = { ...row, label, base_url, api_key_enc, key_mask, validated_at, default_model,
          enabled_models: JSON.parse(enabled), is_default, updated, model_cache: JSON.parse(models), model_cache_at };
        return { rows: [row] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  t.after(() => {
    server.close(); upstream.close();
    if (previousPolicy === undefined) delete process.env.NIXRE_AI_PRIVATE_ORIGINS;
    else process.env.NIXRE_AI_PRIVATE_ORIGINS = previousPolicy;
    if (previousSecret === undefined) delete process.env.AI_SECRET;
    else process.env.AI_SECRET = previousSecret;
  });
  const patch = body => post(body, '/api/v1/ai/providers/7', 'PATCH');

  const renamed = await patch({ label: 'Renamed' });
  assert.equal(renamed.status, 200);
  assert.equal(decryptSecret(row.api_key_enc), 'old-test-key');
  assert.equal(authorization, undefined, 'rename must not contact upstream');

  const rotated = await patch({ apiKey: 'replacement-test-key', baseUrl });
  assert.equal(rotated.status, 200, rotated.body);
  assert.equal(authorization, 'Bearer replacement-test-key');
  assert.equal(decryptSecret(row.api_key_enc), 'replacement-test-key');
  assert.deepEqual(rotated.json.enabledModels, ['keep']);
  assert.equal(rotated.json.defaultModel, 'keep');
  assert.equal(rotated.json.id, 7);
  assert.ok(!rotated.body.includes('replacement-test-key'));

  reject = true;
  const saved = structuredClone(row);
  const before = writes;
  const failed = await patch({ apiKey: 'invalid-test-key' });
  assert.equal(failed.status, 400);
  assert.equal(writes, before, 'failed validation must not partially save anything');
  assert.deepEqual(row, saved);

  reject = false;
  row = { ...row, api_key_enc: null, key_mask: null };
  const keyless = await patch({ baseUrl: `${baseUrl}/v1` });
  assert.equal(keyless.status, 200, keyless.body);
  assert.equal(authorization, undefined);
  assert.ok(row.validated_at > 1);
  assert.equal((await patch({ baseUrl: '' })).status, 400);
  assert.equal((await patch({ label: ' ' })).status, 400);
});

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

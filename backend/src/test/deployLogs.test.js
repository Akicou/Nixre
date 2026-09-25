// Deployment log + env routes: who may read a failed build, what the aliases
// resolve to, and that secret VALUES never leave the server through them.
//
// A public repo is used on purpose: read access is the weakest gate the
// deployments router has, so if build output were readable at that level, it
// would be readable by anonymous visitors of any public repo.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import express from 'express';
import { deploymentRoutes } from '../routes/deployments.js';

const SECRET = 'pg://user:sup3r-s3cret@db/app';

async function fixture(t, { member = true } = {}) {
  const deployments = [
    {
      id: 41,
      service_id: 1,
      ref: 'main',
      sha: 'aaaaaaaabbbb',
      message: 'ok',
      trigger_kind: 'manual',
      status: 'live',
      error: null,
      image_tag: 'img:41',
      build_log: 'step 1\nstep 2\nDONE\n',
      runtime_log: null,
      started: 1000,
      finished: 1100,
      duration_ms: 100,
    },
    {
      id: 42,
      service_id: 1,
      ref: 'main',
      sha: 'ccccccccdddd',
      message: 'boom',
      trigger_kind: 'manual',
      status: 'failed',
      error: 'Health check failed: app did not answer on port 8080 / within 30s (no response)',
      image_tag: 'img:42',
      build_log: 'b1\nb2\nb3\nb4\nb5\n',
      runtime_log: 'Traceback…\nKeyError: DATABASE_URL\n',
      started: 2000,
      finished: 2100,
      duration_ms: 100,
    },
  ];
  const env = new Map([['DATABASE_URL', SECRET]]);

  const pool = {
    async query(sql, params = []) {
      if (sql.includes('FROM repos')) {
        return { rows: [{ id: 7, space_uid: 'dev', uid: 'repo', is_public: true }] };
      }
      if (sql.includes('FROM deploy_services')) {
        return { rows: [{ id: 1, repo_id: 7, current_deployment_id: 41, container_port: 8080 }] };
      }
      if (sql.includes('FROM space_members')) return { rows: member ? [{ member: true }] : [] };
      if (sql.includes("status = 'failed'")) {
        return { rows: deployments.filter(d => d.status === 'failed').slice(-1) };
      }
      if (sql.includes('FROM deployments') && sql.includes('ORDER BY started DESC LIMIT 1')) {
        return { rows: [deployments.at(-1)] };
      }
      if (sql.includes('FROM deployments')) {
        return { rows: deployments.filter(d => d.id === params[0] && d.service_id === params[1]) };
      }
      if (sql.includes('FROM service_env_vars')) {
        return {
          rows: [...env].map(([key]) => ({ key, updated: 5, value_enc: `enc(${env.get(key)})` })),
        };
      }
      throw new Error(`Unhandled test query: ${sql}`);
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { user: { uid: 'dev', admin: false } };
    next();
  });
  app.use(deploymentRoutes(pool, () => (_req, _res, next) => next()));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });

  async function request(method, suffix = '', body) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: server.address().port,
          path: `/repos/dev/repo/+/deployments/services/1${suffix}`,
          method,
          headers: { 'content-type': 'application/json' },
        },
        res => {
          let text = '';
          res.on('data', d => {
            text += d;
          });
          res.on('end', () => {
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch {
              /* text/plain response */
            }
            resolve({ status: res.statusCode, text, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  return { request, deployments };
}

test('a failed deployment build log is reachable by alias, tailable, and carries the container output', async t => {
  const { request } = await fixture(t);

  const byAlias = await request('GET', '/deployments/failed/log?stream=all');
  assert.equal(byAlias.status, 200);
  assert.match(byAlias.text, /# deployment 42 — failed/);
  assert.match(byAlias.text, /Health check failed/);
  assert.match(byAlias.text, /--- build log ---/);
  assert.match(byAlias.text, /b5/);
  // The reason a release failed lives in the container's own output.
  assert.match(byAlias.text, /KeyError: DATABASE_URL/);

  const tailed = await request('GET', '/deployments/42/log?tail=2');
  assert.equal(tailed.status, 200);
  assert.match(tailed.text, /b4\nb5/);
  assert.ok(!tailed.text.includes('b3'), 'tail=2 keeps only the last two lines');

  const latest = await request('GET', '/deployments/latest/log?format=json');
  assert.equal(latest.status, 200);
  assert.equal(latest.body.deployment_id, 42);
  assert.equal(latest.body.status, 'failed');

  const asJson = await request('GET', '/deployments/41/log?format=json&stream=build');
  assert.equal(asJson.body.deployment_id, 41);
  assert.match(asJson.body.build_log, /DONE/);
  assert.equal(asJson.body.runtime_log, undefined);
});

test('log routes validate their input instead of passing it through', async t => {
  const { request } = await fixture(t);
  assert.equal((await request('GET', '/deployments/not-an-id/log')).status, 404);
  assert.equal((await request('GET', '/deployments/999/log')).status, 404);
  assert.equal((await request('GET', '/deployments/42/log?tail=0')).status, 400);
  assert.equal((await request('GET', '/deployments/42/log?tail=99999')).status, 400);
  assert.equal((await request('GET', '/deployments/42/log?tail=abc')).status, 400);
  assert.equal((await request('GET', '/logs?tail=0')).status, 400);
  assert.equal((await request('GET', '/logs?tail=5000')).status, 400);
  assert.equal((await request('GET', '/logs?deployment_id=nope')).status, 400);
  assert.equal((await request('GET', '/logs?deployment_id=999')).status, 404);
  // Redeploy/rollback/delete resolve the id too — junk must not reach Postgres.
  assert.equal((await request('POST', '/deployments/nope/redeploy')).status, 404);
  assert.equal((await request('POST', '/deployments/nope/rollback')).status, 404);
  assert.equal((await request('DELETE', '/deployments/nope')).status, 404);
});

test('a reader without write access gets status but no log bodies', async t => {
  const { request } = await fixture(t, { member: false });

  // Public repo, so the read gate passes and the detail route answers …
  const detail = await request('GET', '/deployments/42');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'failed');
  assert.match(detail.body.error, /Health check failed/);
  // … but without the log bodies, which routinely echo secrets.
  assert.equal(detail.body.build_log, '');
  assert.equal(detail.body.runtime_log, '');
  assert.equal(detail.body.logs_readable, false);
  assert.equal(detail.body.has_build_log, true);
  assert.ok(!detail.text.includes('KeyError'), 'container output withheld from non-writers');

  // The dedicated endpoints refuse outright.
  assert.equal((await request('GET', '/deployments/42/log')).status, 403);
  assert.equal((await request('GET', '/logs')).status, 403);
});

test('env var values are never returned by the listing route', async t => {
  const { request } = await fixture(t);
  const listed = await request('GET', '/env');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.map(r => r.key),
    ['DATABASE_URL'],
  );
  assert.ok(!listed.text.includes(SECRET), 'plaintext value must not appear');
  assert.ok(!listed.text.includes('enc('), 'ciphertext must not appear either');
  assert.ok(!Object.hasOwn(listed.body[0], 'value'));
});

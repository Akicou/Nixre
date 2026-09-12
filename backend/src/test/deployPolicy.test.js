import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import express from 'express';
import { deploymentRoutes } from '../routes/deployments.js';

async function fixture(t, admin = false) {
  const user = { uid: 'dev', admin };
  const services = [{ id: 1, repo_id: 7, name: 'legacy', security_policy_version: 1, runtime_options: {} }];
  const writes = [];
  const pool = {
    async connect() { return { query: pool.query, release() {} }; },
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('FROM repos')) return { rows: [{ id: 7, space_uid: 'dev', uid: 'repo', default_branch: 'main' }] };
      if (sql.includes('FROM space_members')) return { rows: [{ member: true }] };
      if (sql.includes('count(*)')) return { rows: [{ n: services.length }] };
      if (sql.startsWith('INSERT INTO deploy_services')) {
        // Creation must leave policy selection to migration 026's DB default.
        assert.ok(!sql.includes('security_policy_version'));
        const columns = sql.match(/deploy_services \(([^)]+)\)/)[1].split(',').map(s => s.trim());
        const row = { id: services.length + 1, ...Object.fromEntries(columns.map((key, i) => [key, params[i]])), security_policy_version: 2 };
        services.push(row);
        writes.push(sql);
        return { rows: [row] };
      }
      if (sql.startsWith('UPDATE deploy_services SET')) {
        const columns = sql.slice(sql.indexOf('SET ') + 4, sql.lastIndexOf('WHERE')).split(',').map(s => s.trim().split(' ')[0]);
        const row = services.find(s => s.id === params.at(-1));
        columns.forEach((column, index) => { row[column] = params[index]; });
        writes.push(sql);
        return { rows: [] };
      }
      if (sql.includes('FROM deploy_services')) return { rows: sql.includes('WHERE id =')
        ? services.filter(s => s.id === params[0]) : services };
      throw new Error(`Unexpected test query: ${sql}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { user }; next(); });
  app.use(deploymentRoutes(pool, () => (_req, _res, next) => next(), { listTree: async () => ['Dockerfile'] }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  async function request(method, suffix = '', body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/repos/dev/repo/+/deployments/services${suffix}`, {
      method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }
  return { user, services, writes, request };
}

test('new service API rows use policy 2 and reject all create-time policy overrides', async t => {
  const { request, services, user } = await fixture(t);
  const created = await request('POST', '', { name: 'new-app', dockerfile_path: 'Dockerfile' });
  assert.equal(created.status, 201);
  assert.equal(created.body.security_policy_version, 2);
  for (const version of [1, 2, null]) {
    assert.equal((await request('POST', '', { security_policy_version: version })).status, 403);
  }
  user.admin = true;
  assert.equal((await request('POST', '', { security_policy_version: 1 })).status, 400);
  assert.equal(services.length, 2);
});

test('policy PATCH requires admin and strict numeric validation before any writes', async t => {
  const { request, services, writes, user } = await fixture(t);
  for (const version of [1, 2, null]) {
    const response = await request('PATCH', '/1', { env: { SHOULD_NOT_WRITE: 'x' }, security_policy_version: version });
    assert.equal(response.status, 403);
  }
  user.admin = true;
  for (const version of [null, '1', '2', true, false, 0, 3, 1.5, {}, []]) {
    const response = await request('PATCH', '/1', { env: { SHOULD_NOT_WRITE: 'x' }, security_policy_version: version });
    assert.equal(response.status, 400);
  }
  assert.equal(services[0].security_policy_version, 1);
  assert.equal(writes.length, 0);
});

test('admin explicitly migrates a legacy service; unrelated PATCH and option reset never downgrade it', async t => {
  const { request, services, user } = await fixture(t, true);
  assert.equal((await request('GET')).body[0].security_policy_version, 1);
  const upgraded = await request('PATCH', '/1', { security_policy_version: 2 });
  assert.equal(upgraded.status, 200);
  assert.equal(upgraded.body.security_policy_version, 2);
  assert.equal(services[0].security_policy_version, 2);
  user.admin = false;
  const reset = await request('PATCH', '/1', { runtime_options: null, name: 'renamed' });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.runtime_options, null);
  assert.equal(reset.body.security_policy_version, 2);
  assert.equal((await request('PATCH', '/1', { security_policy_version: 1 })).status, 403);
  user.admin = true;
  const explicitDowngrade = await request('PATCH', '/1', { security_policy_version: 1 });
  assert.equal(explicitDowngrade.status, 200);
  assert.equal(explicitDowngrade.body.security_policy_version, 1);
});

test('Postgres policy migration preserves old rows at 1 and defaults new rows to 2', {
  skip: !process.env.NIXRE_TEST_DATABASE_URL && 'Requires an explicitly configured disposable PostgreSQL test database',
}, async t => {
  const client = new pg.Client({ connectionString: process.env.NIXRE_TEST_DATABASE_URL });
  await client.connect();
  t.after(() => client.end());
  // A connection-local temp table prevents writes to any persistent service table.
  await client.query('CREATE TEMP TABLE deploy_services (id INTEGER PRIMARY KEY)');
  await client.query('INSERT INTO deploy_services (id) VALUES (1)');
  await client.query(readFileSync(new URL('../db/migrations/026_deployment_security_policy.sql', import.meta.url), 'utf8'));
  await client.query('INSERT INTO deploy_services (id) VALUES (2)');
  assert.deepEqual((await client.query('SELECT * FROM deploy_services ORDER BY id')).rows, [
    { id: 1, security_policy_version: 1 }, { id: 2, security_policy_version: 2 },
  ]);
  await assert.rejects(client.query('UPDATE deploy_services SET security_policy_version = 3'), { code: '23514' });
});

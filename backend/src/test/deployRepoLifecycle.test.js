import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { forgeRoutes } from '../routes/forge.js';

test('repository deletion cannot cascade away deployment metadata before containers stop', async t => {
  const queries = [];
  const pool = { async connect() { return { query: pool.query, release() {} }; }, async query(sql, params) {
    queries.push({ sql, params });
    if (['BEGIN', 'ROLLBACK', 'COMMIT'].includes(sql)) return { rows: [] };
    if (sql.includes('FROM repos')) return { rows: [{ id: '7', uid: 'app', space_uid: 'lab' }] };
    if (sql.includes('FROM deploy_services')) return { rows: [{ id: '42' }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const app = express();
  app.use('/api/v1', forgeRoutes(pool, () => (req, _res, next) => {
    req.auth = { user: { uid: 'operator', admin: true } };
    next();
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/repos/lab/app/+`, { method: 'DELETE' });
  assert.equal(response.status, 409);
  assert.match((await response.json()).message, /deployment services.*Persistent volumes/);
  assert.deepEqual(queries.find(({ sql }) => sql.includes('FOR UPDATE')).params, ['7']);
  assert.equal(queries.at(-1).sql, 'ROLLBACK');
  assert.ok(queries.every(({ sql }) => !/^(DELETE|UPDATE)/.test(sql)));
});

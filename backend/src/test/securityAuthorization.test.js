import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { authRoutes } from '../routes/auth.js';
import { forgeRoutes } from '../routes/forge.js';
import { pullRequestRoutes } from '../routes/pullreq.js';

async function serve(t, pool, user = { uid: 'owner', admin: false }) {
  const app = express();
  app.use(express.json());
  const auth = () => (req, _res, next) => { req.auth = { user }; next(); };
  app.use('/api/v1', authRoutes(pool, auth));
  app.use('/api/v1', forgeRoutes(pool, auth));
  app.use('/api/v1', pullRequestRoutes(pool, auth));
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json() };
  };
}

test('canonical repo and all PR read routes enforce visibility; Express compare mounts', async t => {
  for (const [user, isPublic, member, allowed] of [
    [{ uid: 'outsider' }, false, false, false],
    [{ uid: 'member' }, false, true, true],
    [{ uid: 'admin', admin: true }, false, false, true],
    [{ uid: 'outsider' }, true, false, true],
    [{ uid: 'blocked', blocked: true, admin: true }, true, true, false],
  ]) {
    const queries = [];
    const pool = { async query(sql) {
      queries.push(sql);
      if (sql.includes('FROM repos')) return { rows: [{ id: 1, space_uid: 'org', uid: 'repo', is_public: isPublic }] };
      if (sql.includes('FROM space_members')) return { rows: member ? [{ role: 'member' }] : [] };
      if (sql.includes('SELECT * FROM pull_requests')) return { rows: [{ number: 1, title: 'private fixture', author_uid: 'author' }] };
      return { rows: [] };
    } };
    const request = await serve(t, pool, user);
    for (const suffix of ['', '/pullreq', '/pullreq/1', '/compare', ...(!allowed ? ['/pullreq/1/diff'] : [])]) {
      const result = await request('/repos/org/repo/+' + suffix);
      assert.equal(result.status, allowed ? (suffix === '/compare' ? 400 : 200) : 404, `${user.uid}: ${suffix}`);
      if (!allowed) assert.equal(result.json.message, 'Repository not found');
    }
    if (!allowed) assert.ok(queries.every(sql => !sql.includes('FROM pull_requests')));
  }
});

// Transactional fixture models the shared allocation lock, not PostgreSQL SQL
// isolation itself. The optional Postgres suite exercises the real statements.
function namespacePool({ failSession = false } = {}) {
  let state = { users: [{ uid: 'owner', email: 'owner@example.test' }], spaces: [], members: [], sessions: [] };
  let tail = Promise.resolve();
  const locks = [];
  return {
    get state() { return state; }, locks,
    async query() { throw new Error('Allocation must not acquire another pooled connection'); },
    async connect() {
      let local;
      let unlock;
      return {
        async query(sql, params = []) {
          if (sql.startsWith('BEGIN')) return { rows: [] };
          if (sql.includes('pg_advisory_xact_lock')) {
            locks.push(sql);
            const previous = tail;
            tail = new Promise(resolve => { unlock = resolve; });
            await previous;
            local = structuredClone(state);
          } else if (sql.includes('UNION ALL')) {
            const name = params[0].toLowerCase();
            return { rows: [...local.users, ...local.spaces].filter(row => row.uid.toLowerCase() === name ||
              (params[1] && row.email?.toLowerCase() === params[1].toLowerCase())) };
          } else if (sql.includes('SELECT count')) {
            return { rows: [{ n: local.users.length }] };
          } else if (sql.includes('INSERT INTO users')) {
            const row = { uid: params[0], email: params[1], display_name: params[2], admin: params[4] };
            local.users.push(row);
            return { rows: [row] };
          } else if (sql.includes('INSERT INTO spaces')) {
            const personal = sql.includes('is_personal');
            const row = { uid: params[0], created_by: personal ? params[0] : params[3], is_personal: personal };
            local.spaces.push(row);
            return { rows: [row] };
          } else if (sql.includes('INSERT INTO space_members')) {
            local.members.push({ space: params[0], user: params.length === 2 ? params[0] : params[1], role: 'owner' });
          } else if (sql.includes('INSERT INTO sessions')) {
            if (failSession) throw new Error('session insert failed');
            local.sessions.push({ id: params[0], hash: params[1], uid: params[2] });
          } else if (sql === 'COMMIT') {
            state = local;
            unlock();
            unlock = null;
          } else if (sql === 'ROLLBACK') {
            unlock?.();
            unlock = null;
          } else {
            throw new Error('Unexpected fixture SQL: ' + sql);
          }
          return { rows: [] };
        },
        release() { assert.equal(unlock, null, 'release only after transaction completion'); },
      };
    },
  };
}

const signup = uid => ({ uid, email: uid.toLowerCase() + '@example.test', password: 'fixture-password' });

test('registration never acquires an existing organization, including case variants', async t => {
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  const pool = namespacePool();
  pool.state.spaces.push({ uid: 'victim-org', created_by: 'owner' });
  const request = await serve(t, pool);
  assert.equal((await request('/register', signup('VICTIM-ORG'))).status, 409);
  assert.equal(pool.state.users.length, 1);
  assert.equal(pool.state.members.length, 0);
});

test('registration and organization creation share one lock and reserve usernames in both directions', async t => {
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  const pool = namespacePool();
  const request = await serve(t, pool);
  const results = await Promise.all([
    request('/register', signup('Collision')),
    request('/spaces', { uid: 'collision' }),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(pool.state.spaces.filter(s => s.uid.toLowerCase() === 'collision').length, 1);
  assert.equal(pool.state.members.length, 1);
  assert.equal(new Set(pool.locks).size, 1);
  assert.equal((await request('/spaces', { uid: 'OWNER' })).status, 409);
});

test('simultaneous first registrations create exactly one admin, with atomic hashed sessions', async t => {
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  const pool = namespacePool();
  pool.state.users.length = 0;
  const request = await serve(t, pool);
  const results = await Promise.all(['first', 'second'].map(uid => request('/register', signup(uid))));
  assert.ok(results.every(r => r.status === 201));
  assert.equal(pool.state.users.filter(u => u.admin).length, 1);
  assert.equal(pool.state.sessions.length, 2);
  for (const row of pool.state.sessions) {
    assert.match(row.hash, /^[a-f0-9]{64}$/);
    assert.ok(results.every(r => r.json.access_token !== row.id));
  }
});

test('session insertion failure rolls back account and personal namespace together', async t => {
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  const pool = namespacePool({ failSession: true });
  const request = await serve(t, pool);
  assert.equal((await request('/register', signup('failed'))).status, 500);
  assert.equal(pool.state.users.length, 1);
  assert.deepEqual(pool.state.spaces, []);
  assert.deepEqual(pool.state.members, []);
});

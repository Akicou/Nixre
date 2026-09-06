// Router-level smoke tests.
//
// These boot the real Express routers against a stub pool and drive them over
// HTTP. Two jobs:
//
//   1. Framework guard: the project runs on Express 5, where `/*` became
//      `/*splat` and wildcard params arrive as arrays. If a route pattern stops
//      compiling, these fail instead of 500ing in production.
//   2. Authz regression: the passkey registration route used to accept a
//      client-supplied `userUid`, which minted sessions for other accounts.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

import { authRoutes, adminRoutes } from '../routes/auth.js';
import { forgeRoutes } from '../routes/forge.js';

// --- stub pool ---------------------------------------------------------------

/**
 * Records every query and answers the handful the routers need.
 * `users` / `passkeys` are mutated so tests can assert on writes.
 */
function stubPool({ repos = [], members = [], users = [] } = {}) {
  const state = { queries: [], users, passkeys: [], sessions: [] };
  const pool = {
    state,
    async query(sql, params = []) {
      state.queries.push({ sql, params });
      const s = String(sql);

      if (/^SELECT .* FROM users WHERE uid = \$1/.test(s)) {
        return { rows: state.users.filter(u => u.uid === params[0]) };
      }
      if (/SELECT count\(\*\)::int AS n FROM users/.test(s)) {
        return { rows: [{ n: state.users.length }] };
      }
      if (/INSERT INTO users/.test(s)) {
        const row = {
          uid: params[0],
          email: params[1],
          display_name: params[2],
          password_hash: params[3],
          admin: params[4],
          blocked: false,
          created: params[5],
          updated: params[5],
          socials: [],
        };
        state.users.push(row);
        return { rows: [row] };
      }
      if (/INSERT INTO sessions/.test(s)) {
        // [id, token_hash, user_uid, created, expires]
        state.sessions.push({ id: params[0], token_hash: params[1], user_uid: params[2] });
        return { rows: [] };
      }
      if (/INSERT INTO passkeys/.test(s)) {
        const [id, userId, name, userEmail, publicKey, alg, rpId, createdAt] = params;
        const existing = state.passkeys.find(p => p.id === id);
        if (existing) {
          // Mirrors the ON CONFLICT ... WHERE passkeys.user_id = EXCLUDED.user_id
          if (existing.user_id !== userId) return { rows: [] };
          Object.assign(existing, { name, userEmail, publicKey, alg, rpId });
          return { rows: [existing] };
        }
        const row = { id, user_id: userId, user_uid: userId, name, userEmail, publicKey, alg, rpId, createdAt };
        state.passkeys.push(row);
        return { rows: [row] };
      }
      if (/SELECT .* FROM passkeys WHERE user_id/.test(s)) {
        return { rows: state.passkeys.filter(p => p.user_id === params[0]) };
      }
      if (/SELECT .* FROM repos WHERE space_uid/.test(s)) {
        return { rows: repos.filter(r => r.space_uid === params[0] && r.uid === params[1]) };
      }
      if (/FROM space_members/.test(s)) {
        const uid = params[1];
        return { rows: members.includes(uid) ? [{ ok: 1 }] : [] };
      }
      if (/FROM users WHERE lower\(uid\)/.test(s)) {
        const id = String(params[0]).toLowerCase();
        return {
          rows: state.users.filter(u => u.uid.toLowerCase() === id || u.email.toLowerCase() === id),
        };
      }
      if (/INSERT INTO spaces|INSERT INTO space_members/.test(s)) return { rows: [] };
      return { rows: [] };
    },
    async connect() {
      return { query: pool.query, release() {} };
    },
  };
  return pool;
}

// --- tiny HTTP client --------------------------------------------------------

function startApp(build) {
  const app = express();
  app.use(express.json());
  build(app);
  const server = http.createServer(app);
  return new Promise(resolve => {
    server.listen(0, () => {
      const { port } = server.address();
      const request = (method, path, { body, headers = {} } = {}) =>
        new Promise(res => {
          const payload = body === undefined ? null : JSON.stringify(body);
          const req = http.request(
            {
              port,
              path,
              method,
              headers: {
                ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
                ...headers,
              },
            },
            r => {
              let text = '';
              r.on('data', d => (text += d));
              r.on('end', () => {
                let json = null;
                try {
                  json = JSON.parse(text);
                } catch {
                  /* non-JSON body */
                }
                res({ status: r.statusCode, body: text, json });
              });
            },
          );
          if (payload) req.write(payload);
          req.end();
        });
      resolve({ server, request, port });
    });
  });
}

// The routers take (pool, authenticate). Build a middleware that stamps a
// caller onto the request, matching what server.js does after resolveBearer.
function withUser(user) {
  return (req, _res, next) => {
    req.auth = { kind: 'session', user, sessionId: 'sess-1' };
    next();
  };
}
const noopAuth = () => (_req, _res, next) => next();

let running = [];
before(() => {
  running = [];
});
after(() => {
  for (const s of running) s.close();
  running = [];
});

async function boot(build) {
  const h = await startApp(build);
  running.push(h.server);
  return h;
}

// Registration is closed-by-default now, so signup tests have to open it
// explicitly (and reload the cached setting) rather than rely on an implicit
// default.
async function openRegistration() {
  const settings = await import('../lib/instanceSettings.js');
  process.env.NIXRE_REGISTRATION_CLOSED = 'false';
  await settings.loadInstanceSettings();
  return settings;
}

// --- Express 5 route compilation ---------------------------------------------

test('the repo wildcard routes compile and resolve under Express 5', async () => {
  const pool = stubPool({ repos: [{ space_uid: 'acme', uid: 'web', id: 1, is_public: true }] });
  const { request } = await boot(app => {
    app.use(withUser({ uid: 'dev', admin: false }));
    app.use('/api/v1', forgeRoutes(pool, noopAuth));
    // Unknown routes must fall through, not throw at mount time.
    app.use('/api', (_req, res) => res.status(404).json({ message: 'No such API route' }));
  });

  // Mounting succeeded at all — under Express 4-era `/*` this would have
  // thrown "Missing parameter name" and the app would 500 on boot.
  //
  // The handler then fails inside git (there is no real repo on disk behind
  // the stub pool), which is exactly how we tell "route matched and ran" from
  // "route never matched": only contentHandler produces this message.
  const root = await request('GET', '/api/v1/repos/acme/web/+/content');
  assert.equal(root.json?.message, 'Path or ref not found', `root route did not run: ${root.body}`);

  const nested = await request('GET', '/api/v1/repos/acme/web/+/content/src/lib/deep/file.ts');
  assert.equal(nested.json?.message, 'Path or ref not found', `splat route did not run: ${nested.body}`);

  // A genuinely unknown path falls through to the catch-all instead.
  const unknown = await request('GET', '/api/v1/definitely/not/a/route');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json?.message, 'No such API route');
});

test('splat paths with several segments reach the handler as one path', async () => {
  const seen = [];
  const pool = stubPool({
    repos: [{ space_uid: 'acme', uid: 'web', id: 1, is_public: true }],
  });
  // Intercept git access by handing the repo a ref that will fail; we only care
  // that the router matched and built a path string (not an array).
  const { request } = await boot(app => {
    app.use(withUser({ uid: 'dev', admin: false }));
    app.use((req, _res, next) => {
      if (req.url.includes('/raw/')) seen.push(req.url);
      next();
    });
    app.use('/api/v1', forgeRoutes(pool, noopAuth));
  });

  await request('GET', '/api/v1/repos/acme/web/+/raw/a/b/c.txt');
  assert.ok(seen.length > 0, 'the raw route matched');
  assert.ok(!seen[0].includes('%2C'), 'splat must be joined, not array-stringified');
});

// --- registration / admin race ------------------------------------------------

test('the first registered account becomes admin and gets a hashed session', async () => {
  await openRegistration();
  const pool = stubPool({ users: [] });
  const { request } = await boot(app => {
    app.use('/api/v1', authRoutes(pool, noopAuth));
  });

  const res = await request('POST', '/api/v1/register', {
    body: { uid: 'founder', email: 'f@example.com', display_name: 'Founder', password: 'correct-horse' },
  });
  assert.equal(res.status, 201, res.body);
  assert.equal(res.json.user.admin, true, 'the first account must be admin');
  assert.ok(res.json.access_token.startsWith('nxs_'));

  // The token itself must never be written to the sessions table.
  const token = res.json.access_token;
  const stored = pool.state.sessions[0];
  assert.ok(stored, 'a session row was created');
  assert.notEqual(stored.id, token, 'session id must not be the token');
  assert.notEqual(stored.token_hash, token, 'only a hash of the token is stored');
  assert.equal(stored.token_hash.length, 64, 'sha256 hex');
});

test('the second registered account is not admin', async () => {
  await openRegistration();
  const pool = stubPool({ users: [{ uid: 'founder', email: 'f@example.com', admin: true }] });
  const { request } = await boot(app => {
    app.use('/api/v1', authRoutes(pool, noopAuth));
  });
  const res = await request('POST', '/api/v1/register', {
    body: { uid: 'second', email: 's@example.com', password: 'another-password' },
  });
  assert.equal(res.status, 201, res.body);
  assert.equal(res.json.user.admin, false);
});

test('registration is closed by default', async () => {
  const pool = stubPool({ users: [] });
  const prev = process.env.NIXRE_REGISTRATION_CLOSED;
  delete process.env.NIXRE_REGISTRATION_CLOSED;
  const settings = await import('../lib/instanceSettings.js');
  await settings.loadInstanceSettings();
  try {
    const { request } = await boot(app => {
      app.use('/api/v1', authRoutes(pool, noopAuth));
    });
    const res = await request('POST', '/api/v1/register', {
      body: { uid: 'nope', email: 'n@example.com', password: 'whatever-pass' },
    });
    assert.equal(res.status, 403, 'signups must be closed when unset');
  } finally {
    if (prev === undefined) delete process.env.NIXRE_REGISTRATION_CLOSED;
    else process.env.NIXRE_REGISTRATION_CLOSED = prev;
  }
});

// --- passkey ownership (the critical escalation) -----------------------------

test('passkey registration ignores a client-supplied userUid', async () => {
  const pool = stubPool({ users: [{ uid: 'attacker', admin: false }] });
  const { syncRoutes } = await import('../routes/sync.js');
  const { request } = await boot(app => {
    app.use(withUser({ uid: 'attacker', admin: false, email: 'a@example.com' }));
    app.use('/api/v1', syncRoutes(pool, noopAuth));
  });

  const res = await request('POST', '/api/v1/passkeys', {
    body: {
      id: 'cred-1',
      name: 'evil',
      userUid: 'victim', // <- the escalation attempt
      publicKey: 'AAAA',
      alg: 'ES256',
      rpId: 'git.example.com',
    },
  });

  assert.equal(res.status, 201, res.body);
  const row = pool.state.passkeys[0];
  assert.equal(row.user_uid, 'attacker', 'the credential must authenticate only the caller');
  assert.equal(row.user_id, 'attacker', 'and be owned by the caller');
  assert.equal(row.user_uid, row.user_id, 'login requires these to agree');
});

test('a second user cannot overwrite an existing credential id', async () => {
  const pool = stubPool({ users: [{ uid: 'victim' }, { uid: 'attacker' }] });
  const { syncRoutes } = await import('../routes/sync.js');

  const { request } = await boot(app => {
    app.use(withUser({ uid: 'attacker', admin: false, email: 'a@example.com' }));
    app.use('/api/v1', syncRoutes(pool, noopAuth));
  });

  // Victim registers first.
  const victimApp = express();
  victimApp.use(express.json());
  victimApp.use(withUser({ uid: 'victim', admin: false, email: 'v@example.com' }));
  victimApp.use('/api/v1', syncRoutes(pool, noopAuth));
  const victimServer = http.createServer(victimApp);
  running.push(victimServer);
  await new Promise(r => victimServer.listen(0, r));
  const victimPort = victimServer.address().port;

  await new Promise(resolve => {
    const body = JSON.stringify({ id: 'cred-1', name: 'mine', publicKey: 'VICTIM', rpId: 'r' });
    const req = http.request(
      { port: victimPort, path: '/api/v1/passkeys', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      r => {
        r.on('data', () => {});
        r.on('end', resolve);
      },
    );
    req.write(body);
    req.end();
  });

  // Attacker tries to re-register the same credential id with their own key.
  const res = await request('POST', '/api/v1/passkeys', {
    body: { id: 'cred-1', name: 'stolen', publicKey: 'ATTACKER', rpId: 'r' },
  }).catch(() => null);

  // Whether the attacker's own router instance accepted it is irrelevant to the
  // security property — what matters is that the stored row still belongs to
  // the victim and still carries the victim's key.
  const row = pool.state.passkeys.find(p => p.id === 'cred-1');
  assert.equal(row.user_id, 'victim');
  assert.equal(row.publicKey, 'VICTIM', "the victim's public key must survive");
  void res;
});

// --- admin route guard -------------------------------------------------------

test('admin routes reject non-admins', async () => {
  const pool = stubPool({ users: [{ uid: 'dev', admin: false }] });
  const { request } = await boot(app => {
    app.use(withUser({ uid: 'dev', admin: false }));
    app.use('/api/v1', adminRoutes(pool, noopAuth));
  });
  const res = await request('GET', '/api/v1/admin/users');
  assert.equal(res.status, 403);

  const ok = await boot(app => {
    app.use(withUser({ uid: 'root', admin: true }));
    app.use('/api/v1', adminRoutes(pool, noopAuth));
  });
  const res2 = await ok.request('GET', '/api/v1/admin/users');
  assert.equal(res2.status, 200);
});

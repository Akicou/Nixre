// nixre-core — the sovereign Nixre backend.
//
// Phase 1 scope: first-party auth (users/sessions in Postgres, argon2) plus
// the absorbed sync API (prefs / conversations / passkeys). Spaces, repos,
// git data and pull requests still come from Gitness until later phases;
// those routes are proxied transparently so the UI needs no branching.
//
// Route map:
//   /api/v1/login | /register | /logout | /user | /webauthn/login   (auth)
//   /api/v1/admin/users                                              (admin)
//   /api/v1/prefs | /conversations | /passkeys                       (sync)
//   /api/v1/* (everything else)                                      -> Gitness proxy
//   /api/sync/v1/*                                                   (compat alias)

import express from 'express';
import pg from 'pg';
import { migrate } from './db/migrate.js';
import { resolveBearer } from './lib/auth.js';
import { authRoutes, adminRoutes } from './routes/auth.js';
import { syncRoutes } from './routes/sync.js';
import { forgeRoutes } from './routes/forge.js';
import { smartHttp } from './git/smartHttp.js';

const PORT = Number(process.env.PORT || 3002);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://nixre:nixre@localhost:5432/nixre';
const GITNESS_URL = process.env.GITNESS_URL || 'http://nixre-backend:3000';
const PROXY_GITNESS = (process.env.PROXY_GITNESS ?? 'true') !== 'false';

const pool = new pg.Pool({ connectionString: DATABASE_URL });

// ---------------------------------------------------------------------------
// Auth middleware — first-party bearer resolution (session or PAT).
// ---------------------------------------------------------------------------

function authenticate(required = true) {
  return async (req, res, next) => {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
      try {
        const resolved = await resolveBearer(pool, auth.slice('Bearer '.length));
        if (resolved) {
          req.auth = resolved;
          next();
          return;
        }
      } catch (err) {
        console.error('auth resolution failed:', err.message);
        res.status(500).json({ message: 'Auth lookup failed' });
        return;
      }
    }
    if (required) {
      res.status(401).json({ message: 'Missing or invalid bearer token' });
      return;
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.auth?.user?.admin) {
    res.status(403).json({ message: 'Admin access required' });
    return;
  }
  next();
}

// ---------------------------------------------------------------------------
// Gitness passthrough for not-yet-migrated endpoints (phases 2-3).
// The UI keeps calling /api/v1/...; core owns some paths and forwards the rest.
// Gitness tokens are forwarded as-is; when the UI migrates fully to core
// sessions this proxy disappears (phase 4).
// ---------------------------------------------------------------------------

function gitnessProxy() {
  return async (req, res) => {
    if (!PROXY_GITNESS) {
      res.status(404).json({ message: 'Not implemented in nixre-core yet' });
      return;
    }
    try {
      const url = new URL(req.originalUrl, GITNESS_URL);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.connection;
      delete headers['content-length'];
      const r = await fetch(url, {
        method: req.method,
        headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body ?? {}),
        redirect: 'manual',
      });
      res.status(r.status);
      const contentType = r.headers.get('content-type');
      if (contentType) res.set('content-type', contentType);
      const buf = Buffer.from(await r.arrayBuffer());
      res.send(buf);
    } catch {
      res.status(502).json({ message: 'Gitness unreachable' });
    }
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// First-party auth endpoints (must be registered before the proxy).
app.use('/api/v1', authRoutes(pool, authenticate));

// Sync + admin routes: per-route authentication (defined inside the routers)
// so requests core does NOT own fall through to the Gitness proxy untouched.
const syncApi = syncRoutes(pool, authenticate);
const adminApi = adminRoutes(pool, authenticate);
app.use('/api/v1', syncApi);
app.use('/api/v1', adminApi);

// Compat alias so existing clients (/api/sync/v1) keep working during the
// transition.
app.use('/api/sync/v1', syncApi);

// Phase 2: spaces, repos and git data are core-owned now. Pull requests and
// account endpoints still fall through to the Gitness proxy (phase 3).
const forgeApi = forgeRoutes(pool, authenticate);
app.use('/api/v1', forgeApi);

// Git Smart HTTP transport (/git/{space}/{repo}.git). No body parser — the
// request stream is piped straight into git http-backend (CGI); express.json
// above ignores git's content types.
app.use('/git', smartHttp(pool, authenticate));

// Everything else under /api/v1 goes to Gitness until phases 2-3 own it.
app.use('/api/v1', express.raw({ type: '*/*' }), async (req, _res, next) => {
  // Re-parse JSON bodies for the proxy (express.raw consumed the stream).
  if (Buffer.isBuffer(req.body) && (req.headers['content-type'] || '').includes('application/json')) {
    try {
      req.body = JSON.parse(req.body.toString('utf8'));
    } catch {
      req.body = undefined;
    }
  }
  next();
}, gitnessProxy());

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal nixre-core error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  let retries = 30;
  while (retries-- > 0) {
    try {
      const client = await pool.connect();
      await migrate(pool);
      client.release();
      break;
    } catch (err) {
      if (retries === 0) throw err;
      console.log(`Database not ready (${err.message}), retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  app.listen(PORT, () => {
    console.log(
      `nixre-core listening on :${PORT} (db ready, gitness proxy ${PROXY_GITNESS ? 'on' : 'off'})`,
    );
  });
}

boot().catch(err => {
  console.error('Failed to start nixre-core:', err);
  process.exit(1);
});

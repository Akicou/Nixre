// nixre-core — the sovereign Nixre backend. 100% Nixre: no forge dependency.
//
// Route map (all first-party, Postgres-backed):
//   /api/v1/login | /register | /logout | /user | /webauthn/login    (auth)
//   /api/v1/admin/users                                               (admin)
//   /api/v1/user/publickeys | /user/tokens                            (account)
//   /api/v1/user/memberships | /spaces... | /repos...                 (forge)
//   /api/v1/repos/.../+/pullreq...                                    (pull reqs)
//   /api/v1/prefs | /conversations | /passkeys                        (sync)
//   /api/sync/v1/*                                                    (compat alias)
//   /git/{space}/{repo}.git                                           (Smart HTTP)

import express from 'express';
import pg from 'pg';
import { migrate } from './db/migrate.js';
import { resolveBearer } from './lib/auth.js';
import { authRoutes, adminRoutes } from './routes/auth.js';
import { syncRoutes } from './routes/sync.js';
import { forgeRoutes } from './routes/forge.js';
import { pullRequestRoutes } from './routes/pullreq.js';
import { accountRoutes } from './routes/account.js';
import { internalRoutes } from './routes/internal.js';
import { webhookRoutes } from './routes/webhooks.js';
import { aiRoutes } from './routes/ai.js';
import { smartHttp } from './git/smartHttp.js';
import { REPOS_ROOT } from './git/repo.js';
import { initSandbox } from './lib/agentSandbox.js';
import { mkdir, access, constants } from 'node:fs/promises';

const PORT = Number(process.env.PORT || 3002);
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://nixre:nixre@localhost:5432/nixre';

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

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '4mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api/v1', authRoutes(pool, authenticate));

// Per-route authentication inside each router.
const syncApi = syncRoutes(pool, authenticate);
app.use('/api/v1', syncApi);
app.use('/api/sync/v1', syncApi); // compat alias

app.use('/api/v1', adminRoutes(pool, authenticate));
app.use('/api/v1', accountRoutes(pool, authenticate));
app.use('/api/v1', forgeRoutes(pool, authenticate));
app.use('/api/v1', pullRequestRoutes(pool, authenticate));
app.use('/api/v1', internalRoutes(pool, authenticate));
app.use('/api/v1', webhookRoutes(pool, authenticate));
app.use('/api/v1', aiRoutes(pool, authenticate));

// Git Smart HTTP transport. No body parser — the request stream is piped
// straight into git http-backend (CGI).
app.use('/git', smartHttp(pool, authenticate));

// Anything else under /api is simply unknown now — there is no proxy.
app.use('/api', (_req, res) => {
  res.status(404).json({ message: 'No such API route' });
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal nixre-core error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function ensureReposRoot() {
  await mkdir(REPOS_ROOT, { recursive: true });
  await access(REPOS_ROOT, constants.W_OK);
}

async function boot() {
  try {
    await ensureReposRoot();
  } catch (err) {
    throw new Error(
      `REPOS_ROOT ${REPOS_ROOT} is not writable (${err.message}). New spaces cannot be created.`,
    );
  }
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
  await initSandbox();
  app.listen(PORT, () => {
    console.log(`nixre-core listening on :${PORT} — sovereign, no forge dependency`);
  });
}

boot().catch(err => {
  console.error('Failed to start nixre-core:', err);
  process.exit(1);
});

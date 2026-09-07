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
import { migrate } from './db/migrate.js';
import { pool as sharedPool } from './db/pool.js';
import { resolveBearer } from './lib/auth.js';
import { authRoutes, adminRoutes } from './routes/auth.js';
import { updateRoutes } from './routes/updates.js';
import { updateMaintenance } from './lib/instanceUpdater.js';
import { syncRoutes } from './routes/sync.js';
import { forgeRoutes } from './routes/forge.js';
import { pullRequestRoutes } from './routes/pullreq.js';
import { accountRoutes } from './routes/account.js';
import { avatarRoutes } from './routes/avatar.js';
import { internalRoutes } from './routes/internal.js';
import { webhookRoutes } from './routes/webhooks.js';
import { deploymentRoutes } from './routes/deployments.js';
import { aiRoutes } from './routes/ai.js';
import { smartHttp } from './git/smartHttp.js';
import { REPOS_ROOT } from './git/repo.js';
import { initSandbox } from './lib/agentSandbox.js';
import { sweepStaleRuns } from './lib/agentJobs.js';
import { loadInstanceSettings } from './lib/instanceSettings.js';
import { deployEngine, setDeployProxy } from './lib/deployRuntime.js';
import { createDeployProxy } from './lib/deployProxy.js';
import { mkdir, access, constants } from 'node:fs/promises';
import { createRateLimiter, clientKey } from './lib/rateLimit.js';
import { securityHeaders } from './lib/securityHeaders.js';
import { pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3002);

const pool = sharedPool;

// ---------------------------------------------------------------------------
// Auth middleware — first-party bearer resolution (session or PAT).
// ---------------------------------------------------------------------------

export function createApp({ pool = sharedPool, authenticate: authenticateOverride } = {}) {
  function authenticate(required = true) {
    if (authenticateOverride) return authenticateOverride(required);
    return async (req, res, next) => {
      if (req.auth) return next();
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

  const app = express();
  // No hop counts: a directly connected caller must not be able to supply XFF.
  app.set('trust proxy', String(process.env.TRUSTED_PROXY_CIDRS || '').split(',').map(s => s.trim()).filter(Boolean));
  app.use(securityHeaders);
  app.use(updateMaintenance());
  app.use(['/api/v1', '/api/sync/v1'], createRequestMiddleware(authenticate));

  app.get('/healthz', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true, ...(process.env.NIXRE_REVISION ? { revision: process.env.NIXRE_REVISION } : {}) });
    } catch { res.status(503).json({ ok: false }); }
  });
  app.use('/api/v1', authRoutes(pool, authenticate));

  // Per-route authentication inside each router.
  const syncApi = syncRoutes(pool, authenticate);
  app.use('/api/v1', syncApi);
  app.use('/api/sync/v1', syncApi); // compat alias
  app.use('/api/v1', adminRoutes(pool, authenticate));
  app.use('/api/v1', updateRoutes(authenticate));
  app.use('/api/v1', accountRoutes(pool, authenticate));
  app.use('/api/v1', avatarRoutes(pool, authenticate));
  app.use('/api/v1', forgeRoutes(pool, authenticate));
  app.use('/api/v1', pullRequestRoutes(pool, authenticate));
  app.use('/api/v1', internalRoutes(pool, authenticate));
  app.use('/api/v1', webhookRoutes(pool, authenticate));
  app.use('/api/v1', aiRoutes(pool, authenticate));
  app.use('/api/v1', deploymentRoutes(pool, authenticate));

  // Git streams never enter the API body parser.
  app.use('/git', smartHttp(pool, authenticate));
  app.use('/api', (_req, res) => {
    res.status(404).json({ message: 'No such API route' });
  });
  app.use(requestErrorHandler);
  return app;
}

// Shared by production and HTTP tests; route matching has Express's case and
// trailing-slash semantics. Limits run before buffering/parsing request bodies.
export function createRequestMiddleware(authenticate) {
  const api = express.Router();
  const limit = (max, name) => createRateLimiter({ windowMs: 60_000, max, name })(clientKey);
  api.post('/login', limit(10, 'login attempts'));
  api.post('/register', limit(5, 'registrations'));
  api.post(['/webauthn/login-challenge', '/webauthn/login'], limit(20, 'passkey attempts'));
  api.post('/ai/tools', limit(120, 'assistant tool calls'));
  api.post([
    '/repos/:space/:repo/\\+/deployments/services/:id/deploy',
    '/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId/redeploy',
    '/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId/rollback',
  ], limit(30, 'deploy triggers'));

  const auth = authenticate(true);
  const json64mb = express.json({ limit: '64mb' });
  api.post(['/login', '/register', '/webauthn/login-challenge', '/webauthn/login'], express.json({ limit: '16kb' }));
  api.post(['/user/avatar', '/spaces/:uid/avatar'], auth, express.json({ limit: '3mb' }));
  api.post('/ai/transcribe', auth, express.json({ limit: '12mb' }));
  api.post([
    '/ai/chat', '/ai/jobs', '/ai/jobs/:conversationId/queue', '/ai/tools',
    '/conversations', '/repos/:space/:repo/\\+/commits',
  ], auth, json64mb);
  api.put('/conversations/:id', auth, json64mb);
  // A parsed stream is not parsed again by body-parser. Git streams never
  // enter this API-only middleware.
  api.use(express.json({ limit: '1mb' }));
  return api;
}

export function requestErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') return res.status(413).json({ message: 'Request body is too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ message: 'Invalid JSON body' });
  if (err.status >= 400 && err.status < 500 && err.expose) {
    return res.status(err.status).json({ message: err.message });
  }
  console.error(err);
  res.status(500).json({ message: 'Internal nixre-core error' });
}

// ---------------------------------------------------------------------------
// Secret hygiene — fail closed on published defaults.
// ---------------------------------------------------------------------------

// docker-compose used to supply `dev-internal-token-change-me` and
// `dev-ai-secret-change-me` whenever the operator forgot to create .env, and
// lib/ai.js fell back to a third literal ('nixre-dev-ai-secret'). All three
// are in this public repository, and /api/v1/internal/* is reachable from the
// internet through Caddy — so a default value is a live credential, not a
// convenience. Refuse to start instead.
const KNOWN_BAD_SECRETS = new Set([
  'dev-internal-token-change-me',
  'dev-ai-secret-change-me',
  'nixre-dev-ai-secret',
  'change-me-internal-token',
  'change-me-ai-secret',
]);

function assertRequiredSecrets() {
  const problems = [];
  const internal = String(process.env.INTERNAL_TOKEN || '');
  const aiSecret = String(process.env.AI_SECRET || '');

  if (!internal) {
    problems.push('INTERNAL_TOKEN is not set');
  } else if (KNOWN_BAD_SECRETS.has(internal)) {
    problems.push('INTERNAL_TOKEN is a published default value');
  } else if (internal.length < 32) {
    problems.push('INTERNAL_TOKEN must be at least 32 characters');
  }

  if (!aiSecret) {
    problems.push('AI_SECRET is not set');
  } else if (KNOWN_BAD_SECRETS.has(aiSecret)) {
    problems.push('AI_SECRET is a published default value');
  } else if (aiSecret.length < 32) {
    problems.push('AI_SECRET must be at least 32 characters');
  }

  // Permit a maintenance boot with legacy DB credentials so operators can
  // migrate deliberately, but make the required rotation visible.
  const dbUrl = String(process.env.DATABASE_URL || '');
  if (process.env.PGPASSWORD === 'nixre' || /\/\/[^:@/]*:nixre@/.test(dbUrl)) {
    console.warn(
      '[core] WARNING: database uses the legacy default password. ' +
        'Rotate the PostgreSQL role password and configuration before reopening ingress.',
    );
  }

  if (problems.length) {
    throw new Error(
      `Refusing to start with weak secrets:\n  - ${problems.join('\n  - ')}\n` +
        'Generate them with: openssl rand -hex 32\n' +
        'For legacy encrypted data, follow docs/security-upgrade.md.',
    );
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function ensureReposRoot() {
  await mkdir(REPOS_ROOT, { recursive: true });
  await access(REPOS_ROOT, constants.W_OK);
}

async function boot() {
  assertRequiredSecrets();
  if (!String(process.env.TRUSTED_PROXY_CIDRS || '').trim()) {
    console.warn('[core] No trusted proxy peers configured. Behind an edge proxy, users share its rate-limit budget; see docs/security-upgrade.md.');
  }
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
      // migrate owns and releases its connection, including secret upgrades.
      await migrate(pool);
      break;
    } catch (err) {
      if (retries === 0) throw err;
      console.log(`Database not ready (${err.message}), retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  const settings = await loadInstanceSettings();
  if (settings.registrationClosed) console.log('Registration closed (signup kill switch active)');
  await sweepStaleRuns(pool);
  await initSandbox();
  await bootDeployments();
  createApp().listen(PORT, () => {
    console.log(`nixre-core listening on :${PORT} — sovereign, no forge dependency`);
  });
}

// Deployments: reconcile in-flight runs from a previous process, autostart
// services whose containers died with the host, then open the central proxy
// port for routed app traffic. Docker being absent degrades gracefully —
// sweeps keep running and pick deployments up when it appears.
async function bootDeployments() {
  await deployEngine.sweep().catch(err => console.error('deploy sweep failed:', err.message));

  const proxyPort = Number(process.env.DEPLOY_PROXY_PORT || 3003);
  if (proxyPort > 0) {
    const proxy = createDeployProxy({ pool, engine: deployEngine });
    setDeployProxy(proxy);
    try {
      const addr = await proxy.listen(proxyPort, process.env.DEPLOY_PROXY_BIND || undefined);
      console.log(`Deploy proxy routing app traffic on :${addr?.port ?? proxyPort}`);
    } catch (err) {
      console.error(`Deploy proxy could not bind :${proxyPort} (${err.message})`);
    }
  }

  const sweepMs = Number(process.env.DEPLOY_SWEEP_MS || 60_000);
  setInterval(() => void deployEngine.sweep().catch(() => {}), sweepMs).unref();

  const probeMs = Number(process.env.DEPLOY_PROBE_MS || 30_000);
  setInterval(() => void deployEngine.probeTick().catch(() => {}), probeMs).unref();

  const metricsMs = Number(process.env.DEPLOY_METRICS_MS || 10_000);
  setInterval(() => void deployEngine.metricsTick().catch(() => {}), metricsMs).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  boot().catch(err => {
    console.error('Failed to start nixre-core:', err);
    process.exit(1);
  });

// A stray rejected promise must not take down core — every active agent job
// dies with it and comes back as "Job lost on core restart". Log loudly and
// keep serving. Uncaught exceptions remain fatal (state may be inconsistent):
// logged with full stack, then exit(1) so docker restarts us cleanly.
  process.on('unhandledRejection', err => {
    console.error('[core] unhandled rejection:', err?.stack || err);
  });
  process.on('uncaughtException', err => {
    console.error('[core] uncaught exception:', err?.stack || err);
    process.exit(1);
  });
}

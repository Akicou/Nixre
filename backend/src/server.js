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

const PORT = Number(process.env.PORT || 3002);

const pool = sharedPool;

// --- rate limits ---------------------------------------------------------------
// Auth endpoints are the brute-force target; small body endpoints do not need
// a 64 MB parser in front of them.
const loginLimiter = createRateLimiter({ windowMs: 60_000, max: 10, name: 'login attempts' });
const registerLimiter = createRateLimiter({ windowMs: 60_000, max: 5, name: 'registrations' });
const passkeyLimiter = createRateLimiter({ windowMs: 60_000, max: 20, name: 'passkey attempts' });
const deployLimiter = createRateLimiter({ windowMs: 60_000, max: 30, name: 'deploy triggers' });
const toolsLimiter = createRateLimiter({ windowMs: 60_000, max: 120, name: 'assistant tool calls' });

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

// Apply a limiter to one method+path before the routers see it. Keeps the
// rate-limit table in one place instead of threading limiters into every
// route file.
function limitOn(method, path, limiter) {
  const limit = limiter(clientKey);
  return (req, res, next) => {
    if (req.method === method && req.path === path) return limit(req, res, next);
    next();
  };
}

// Same, but matching the tail of the path (route params make exact matching
// impractical for nested deploy endpoints).
function limitOnSuffix(method, suffix, limiter) {
  const limit = limiter(clientKey);
  return (req, res, next) => {
    if (req.method === method && req.path.endsWith(suffix)) return limit(req, res, next);
    next();
  };
}

const app = express();

app.use(securityHeaders);

// A 64 MB body parser in front of every route is a cheap way to exhaust the
// process, so only the endpoints that legitimately carry images get it and
// everything else is capped at 1 MB.
//
// The assistant endpoints that accept base64 data URLs: chat (inline images)
// and jobs / queue (the same, plus file attachments). Anything else — /login,
// /register, deploy payloads — stays at 1 MB.
//
// Order matters: these are registered BEFORE the 1 MB parser, because the
// first parser to see a request sets the limit. Registered afterwards, the
// global 1 MB parser would reject an image-bearing body with 413 before the
// larger one ever ran.
const LARGE_BODY_SUFFIXES = ['/ai/chat', '/ai/jobs', '/ai/tools'];
const json1mb = express.json({ limit: '1mb' });
for (const suffix of LARGE_BODY_SUFFIXES) {
  app.use(`/api/v1${suffix}`, express.json({ limit: '64mb' }));
  app.use(`/api/sync/v1${suffix}`, express.json({ limit: '64mb' }));
}
app.use((req, res, next) => {
  // Already parsed by a route-specific parser above.
  if (LARGE_BODY_SUFFIXES.some(s => req.path.endsWith(s))) return next();
  return json1mb(req, res, next);
});

// Brute-force and abuse limits, before any route handling.
app.use('/api/v1', limitOn('POST', '/login', loginLimiter));
app.use('/api/v1', limitOn('POST', '/register', registerLimiter));
app.use('/api/v1', limitOn('POST', '/webauthn/login-challenge', passkeyLimiter));
app.use('/api/v1', limitOn('POST', '/webauthn/login', passkeyLimiter));
app.use('/api/v1', limitOn('POST', '/ai/tools', toolsLimiter));
app.use('/api/v1', limitOnSuffix('POST', '/deploy', deployLimiter));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use('/api/v1', authRoutes(pool, authenticate));

// Per-route authentication inside each router.
const syncApi = syncRoutes(pool, authenticate);
app.use('/api/v1', syncApi);
app.use('/api/sync/v1', syncApi); // compat alias

app.use('/api/v1', adminRoutes(pool, authenticate));
app.use('/api/v1', accountRoutes(pool, authenticate));
app.use('/api/v1', avatarRoutes(pool, authenticate));
app.use('/api/v1', forgeRoutes(pool, authenticate));
app.use('/api/v1', pullRequestRoutes(pool, authenticate));
app.use('/api/v1', internalRoutes(pool, authenticate));
app.use('/api/v1', webhookRoutes(pool, authenticate));
app.use('/api/v1', aiRoutes(pool, authenticate));
app.use('/api/v1', deploymentRoutes(pool, authenticate));

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

  // Postgres ships with nixre/nixre in compose. Warn (do not block) so a
  // development checkout still boots, but make the risk explicit.
  const dbUrl = String(process.env.DATABASE_URL || '');
  if (/\/\/[^:@/]*:nixre@/.test(dbUrl)) {
    console.warn(
      '[core] WARNING: DATABASE_URL uses the default postgres password. ' +
        'Set a real one in .env before exposing this instance.',
    );
  }

  if (problems.length && String(process.env.ALLOW_INSECURE_DEFAULTS || '') !== '1') {
    throw new Error(
      `Refusing to start with weak secrets:\n  - ${problems.join('\n  - ')}\n` +
        'Generate them with: openssl rand -hex 32\n' +
        'Set ALLOW_INSECURE_DEFAULTS=1 to override (local development only).',
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
  const settings = await loadInstanceSettings();
  if (settings.registrationClosed) console.log('Registration closed (signup kill switch active)');
  await sweepStaleRuns(pool);
  await initSandbox();
  await bootDeployments();
  app.listen(PORT, () => {
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

// Deployment routes — services, env vars, deploys, logs, uptime, domains.
//
// Repo-scoped under /repos/{space}/{repo}/+/deployments/... like webhooks and
// pull requests; write actions need space write access, reads follow repo
// visibility. Realtime logs/metrics stream over SSE (fetch-reader pattern).

import express from 'express';
import { encryptSecret } from '../lib/ai.js';
import { deployEngine, getDeployProxy } from '../lib/deployRuntime.js';
import { listTree as gitListTree } from '../lib/deployDrivers.js';
import {
  filterDockerfiles,
  normalizeRootDir,
  sanitizeServiceName,
  shortSha,
} from '../lib/deployPure.js';
import {
  cloudflareConfigured,
  createTunnelCname,
  deleteDnsRecord,
  tunnelCnameTarget,
} from '../lib/cloudflareDns.js';

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export function deploymentRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  async function loadRepo(req, res) {
    const { space, repo } = req.params;
    const { rows } = await pool.query('SELECT * FROM repos WHERE space_uid = $1 AND uid = $2', [
      space,
      repo,
    ]);
    if (!rows[0]) {
      res.status(404).json({ message: 'Repository not found' });
      return null;
    }
    return rows[0];
  }

  async function canWrite(spaceUid, user) {
    if (user.admin) return true;
    const { rows } = await pool.query(
      'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [spaceUid, user.uid],
    );
    return rows.length > 0;
  }

  async function requireWriter(req, res) {
    const repo = await loadRepo(req, res);
    if (!repo) return null;
    if (!(await canWrite(repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    return repo;
  }

  async function loadService(req, res) {
    const repo = await loadRepo(req, res);
    if (!repo) return null;
    // Routes define the service param as ':id'; reject non-numeric ids with a
    // 404 instead of letting Number() produce NaN and blow up in Postgres.
    const serviceId = Number(req.params.id);
    if (!Number.isInteger(serviceId) || serviceId <= 0) {
      res.status(404).json({ message: 'Service not found' });
      return null;
    }
    const { rows } = await pool.query(
      'SELECT * FROM deploy_services WHERE id = $1 AND repo_id = $2',
      [serviceId, repo.id],
    );
    if (!rows[0]) {
      res.status(404).json({ message: 'Service not found' });
      return null;
    }
    return { repo, service: rows[0] };
  }

  async function requireServiceWriter(req, res) {
    const ctx = await loadService(req, res);
    if (!ctx) return null;
    if (!(await canWrite(ctx.repo.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    return ctx;
  }

  // An in-flight error shaped {status} maps onto the response cleanly.
  function guard(fn) {
    return (req, res) => {
      fn(req, res).catch(err => {
        const status = err?.status || 500;
        if (status >= 500) console.error('deployments route:', err);
        res.status(status).json({ message: err?.message || 'Deployment error' });
      });
    };
  }

  async function proxyInvalidate() {
    getDeployProxy()?.invalidateRoutes();
  }

  function rowToService(s, extra = {}) {
    return {
      id: Number(s.id),
      name: s.name,
      root_dir: s.root_dir,
      dockerfile_path: s.dockerfile_path,
      branch: s.branch,
      auto_deploy: Boolean(s.auto_deploy),
      container_port: Number(s.container_port),
      cpu_nano_cpus: Number(s.cpu_nano_cpus),
      memory_bytes: Number(s.memory_bytes),
      desired_state: s.desired_state,
      status: s.status,
      current_deployment_id: s.current_deployment_id == null ? null : Number(s.current_deployment_id),
      last_failed_deployment_id:
        s.last_failed_deployment_id == null ? null : Number(s.last_failed_deployment_id),
      preserve_status_min: Number(s.preserve_status_min ?? 400),
      success_retention_hours: Number(s.success_retention_hours ?? 24),
      failure_retention_hours: Number(s.failure_retention_hours ?? 168),
      created: Number(s.created),
      updated: Number(s.updated),
      ...extra,
    };
  }

  async function currentDeploymentSummary(service) {
    if (!service.current_deployment_id) return null;
    const { rows } = await pool.query(
      'SELECT id, ref, sha, message, status, trigger_kind, started, finished FROM deployments WHERE id = $1',
      [service.current_deployment_id],
    );
    const d = rows[0];
    if (!d) return null;
    return {
      id: Number(d.id),
      ref: d.ref,
      sha: d.sha,
      short_sha: shortSha(d.sha),
      message: d.message,
      status: d.status,
      trigger: d.trigger_kind,
      started: Number(d.started),
      finished: d.finished == null ? null : Number(d.finished),
    };
  }

  // -------------------------------------------------------------------------
  // Services
  // -------------------------------------------------------------------------

  api.get('/repos/:space/:repo/\\+/deployments/services', auth, guard(async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const { rows } = await pool.query(
      'SELECT * FROM deploy_services WHERE repo_id = $1 ORDER BY created ASC',
      [repo.id],
    );
    const out = [];
    for (const s of rows) {
      out.push(rowToService(s, { current: await currentDeploymentSummary(s) }));
    }
    res.json(out);
  }));

  api.post('/repos/:space/:repo/\\+/deployments/services', auth, guard(async (req, res) => {
    const repo = await requireWriter(req, res);
    if (!repo) return;
    const body = req.body || {};
    const name = sanitizeServiceName(body.name || '');
    let rootDir;
    try {
      rootDir = normalizeRootDir(body.root_dir ?? '.');
    } catch {
      res.status(400).json({ message: 'root_dir may not traverse upwards' });
      return;
    }
    const branch = String(body.branch || repo.default_branch || 'main').slice(0, 200);
    const containerPort = Number(body.container_port || 8080);
    if (!(Number.isInteger(containerPort) && containerPort > 0 && containerPort < 65536)) {
      res.status(400).json({ message: 'container_port must be a valid port number' });
      return;
    }

    // The system never guesses: the chosen root must actually contain the
    // chosen Dockerfile.
    const ref = String(body.ref || branch);
    let tree;
    try {
      tree = await gitListTree(repo.space_uid, repo.uid, ref);
    } catch (err) {
      res.status(400).json({ message: `Cannot read ${ref}: ${err.message}` });
      return;
    }
    const found = filterDockerfiles(tree, rootDir);
    const wantedRel = String(body.dockerfile_path || '').replace(/^\.\//, '');
    const match = found.find(d => d.file === wantedRel);
    if (!match) {
      res.status(400).json({
        message: found.length
          ? `Dockerfile '${wantedRel}' not found under ${rootDir === '.' ? '.' : `${rootDir}/`}. Found: ${found.map(f => f.file).join(', ')}`
          : `No Dockerfile detected under ${rootDir === '.' ? 'the repo root' : `${rootDir}/`}`,
        dockerfiles: found,
      });
      return;
    }

    const { rows } = await pool.query(
      `INSERT INTO deploy_services
         (repo_id, name, root_dir, dockerfile_path, branch, auto_deploy,
          container_port, cpu_nano_cpus, memory_bytes, created_by, created, updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
       RETURNING *`,
      [
        repo.id,
        name,
        rootDir,
        match.file,
        branch,
        body.auto_deploy !== false,
        containerPort,
        Math.round(Number(body.cpu_cores || 1) * 1e9) || 1e9,
        Math.round(Number(body.memory_mb || 512) * 1024 * 1024) || 512 * 1024 * 1024,
        req.auth.user.uid,
        Date.now(),
      ],
    );
    const service = rows[0];

    // Env vars may be provided at creation time.
    const env = body.env && typeof body.env === 'object' ? body.env : {};
    for (const [k, v] of Object.entries(env)) {
      if (!ENV_KEY_RE.test(k)) continue;
      await pool.query(
        `INSERT INTO service_env_vars (service_id, key, value_enc, updated) VALUES ($1,$2,$3,$4)
         ON CONFLICT (service_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated = EXCLUDED.updated`,
        [service.id, k, encryptSecret(String(v)), Date.now()],
      );
    }

    res.status(201).json(rowToService(service, { current: null }));
  }));

  const SERVICE_PATCHABLE = new Set([
    'name',
    'root_dir',
    'dockerfile_path',
    'branch',
    'auto_deploy',
    'container_port',
    'cpu_nano_cpus',
    'memory_bytes',
    'preserve_status_min',
    'success_retention_hours',
    'failure_retention_hours',
  ]);

  api.patch('/repos/:space/:repo/\\+/deployments/services/:id', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { service } = ctx;
    const body = req.body || {};

    const sets = {};
    for (const key of Object.keys(body)) {
      if (!SERVICE_PATCHABLE.has(key)) continue;
      let value = body[key];
      if (key === 'root_dir') value = normalizeRootDir(value);
      if (key === 'container_port') {
        const p = Number(value);
        if (!(Number.isInteger(p) && p > 0 && p < 65536)) {
          res.status(400).json({ message: 'container_port invalid' });
          return;
        }
      }
      if (key === 'memory_bytes') value = Math.max(32 * 1024 * 1024, Number(value));
      if (key === 'cpu_nano_cpus') value = Math.max(1e8, Number(value));
      if (['preserve_status_min'].includes(key)) {
        value = Math.min(600, Math.max(100, Number(value)));
      }
      sets[key] = { v: value };
    }

    // desired_state is actuated, not just stored.
    if (typeof body.desired_state === 'string') {
      const want = body.desired_state;
      if (want !== 'running' && want !== 'stopped') {
        res.status(400).json({ message: "desired_state must be 'running' or 'stopped'" });
        return;
      }
      if (want !== service.desired_state) {
        if (want === 'stopped') await deployEngine.stopService(service.id);
        else await deployEngine.startService(service.id);
      }
    }

    if (Object.keys(sets).length > 0) {
      sets.updated = { v: Date.now() };
      const entries = Object.entries(sets);
      const setSql = entries.map(([name], i) => `${name} = $${i + 1}`).join(', ');
      await pool.query(
        `UPDATE deploy_services SET ${setSql} WHERE id = $${entries.length + 1}`,
        [...entries.map(([, v]) => v.v), service.id],
      );
    }
    await proxyInvalidate();

    const fresh = (
      await pool.query('SELECT * FROM deploy_services WHERE id = $1', [service.id])
    ).rows[0];
    res.json(rowToService(fresh, { current: await currentDeploymentSummary(fresh) }));
  }));

  api.delete('/repos/:space/:repo/\\+/deployments/services/:id', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { service } = ctx;
    // Remove every container/image this service owns before the cascade wipes
    // its rows.
    if (service.current_deployment_id) {
      try {
        await deployEngine.stopService(service.id);
      } catch {
        /* already stopped */
      }
    }
    await pool.query('DELETE FROM deploy_services WHERE id = $1', [service.id]);
    await proxyInvalidate();
    res.json({ ok: true });
  }));

  // Dockerfile detection for the wizard — never guesses, only reports.
  api.get('/repos/:space/:repo/\\+/deployments/dockerfiles', auth, guard(async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const ref = String(req.query.ref || repo.default_branch || 'main');
    let rootDir = '.';
    try {
      rootDir = normalizeRootDir(String(req.query.root_dir || '.'));
    } catch {
      res.status(400).json({ message: 'root_dir may not traverse upwards' });
      return;
    }
    try {
      const tree = await gitListTree(repo.space_uid, repo.uid, ref);
      res.json({ ref, root_dir: rootDir, dockerfiles: filterDockerfiles(tree, rootDir) });
    } catch (err) {
      res.status(400).json({ message: `Cannot read ${ref}: ${err.message}` });
    }
  }));

  // -------------------------------------------------------------------------
  // Env vars (Railway-style groups)
  // -------------------------------------------------------------------------

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/env', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT key, updated FROM service_env_vars WHERE service_id = $1 ORDER BY key',
      [ctx.service.id],
    );
    res.json(rows.map(r => ({ key: r.key, updated: Number(r.updated) })));
  }));

  api.put('/repos/:space/:repo/\\+/deployments/services/:id/env', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const vars = req.body?.vars;
    if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
      res.status(400).json({ message: 'vars object required' });
      return;
    }
    const keys = Object.keys(vars);
    if (keys.length > 100) {
      res.status(400).json({ message: 'At most 100 env vars per service' });
      return;
    }
    for (const k of keys) {
      if (!ENV_KEY_RE.test(k)) {
        res.status(400).json({ message: `Invalid env var name '${k}'` });
        return;
      }
      if (typeof vars[k] !== 'string') {
        res.status(400).json({ message: `Env var '${k}' must be a string` });
        return;
      }
    }
    const nowMs = Date.now();
    // Transaction on ONE client — pool.query alone would scatter BEGIN/COMMIT.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM service_env_vars WHERE service_id = $1', [ctx.service.id]);
      for (const k of keys) {
        await client.query(
          'INSERT INTO service_env_vars (service_id, key, value_enc, updated) VALUES ($1,$2,$3,$4)',
          [ctx.service.id, k, encryptSecret(vars[k]), nowMs],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.json({ ok: true, keys });
  }));

  // Deleting one variable must not require replaying every other secret's
  // plaintext (PUT is intentionally full-replace; deletes are surgical).
  api.delete(
    '/repos/:space/:repo/\\+/deployments/services/:id/env/:key',
    auth,
    guard(async (req, res) => {
      const ctx = await requireServiceWriter(req, res);
      if (!ctx) return;
      await pool.query('DELETE FROM service_env_vars WHERE service_id = $1 AND key = $2', [
        ctx.service.id,
        req.params.key,
      ]);
      res.json({ ok: true });
    }),
  );

  api.get(
    '/repos/:space/:repo/\\+/deployments/services/:id/env/:key/reveal',
    auth,
    guard(async (req, res) => {
      const ctx = await requireServiceWriter(req, res);
      if (!ctx) return;
      const { decryptSecret } = await import('../lib/ai.js');
      const { rows } = await pool.query(
        'SELECT value_enc FROM service_env_vars WHERE service_id = $1 AND key = $2',
        [ctx.service.id, req.params.key],
      );
      if (!rows[0]) {
        res.status(404).json({ message: 'No such env var' });
        return;
      }
      res.json({ key: req.params.key, value: decryptSecret(rows[0].value_enc) });
    }),
  );

  // -------------------------------------------------------------------------
  // Deployments & lifecycle
  // -------------------------------------------------------------------------

  api.post('/repos/:space/:repo/\\+/deployments/services/:id/deploy', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const ref = req.body?.ref ? String(req.body.ref).slice(0, 200) : undefined;
    const out = await deployEngine.startDeployment(ctx.service.id, { ref, trigger: 'manual' });
    res.status(202).json(out);
  }));

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/deployments', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const limit = Math.min(100, Number(req.query.limit || 30));
    const { rows } = await pool.query(
      `SELECT id, ref, sha, message, trigger_kind, status, error, started, finished, duration_ms
       FROM deployments WHERE service_id = $1 ORDER BY started DESC LIMIT $2`,
      [ctx.service.id, limit],
    );
    res.json(rows.map(d => ({
      id: Number(d.id),
      ref: d.ref,
      sha: d.sha,
      short_sha: shortSha(d.sha),
      message: d.message,
      trigger: d.trigger_kind,
      status: d.status,
      error: d.error || null,
      started: Number(d.started),
      finished: d.finished == null ? null : Number(d.finished),
      duration_ms: d.duration_ms == null ? null : Number(d.duration_ms),
      serving: Number(d.id) === Number(ctx.service.current_deployment_id),
    })));
  }));

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT * FROM deployments WHERE id = $1 AND service_id = $2',
      [Number(req.params.depId), ctx.service.id],
    );
    const d = rows[0];
    if (!d) {
      res.status(404).json({ message: 'Deployment not found' });
      return;
    }
    res.json({
      id: Number(d.id),
      ref: d.ref,
      sha: d.sha,
      short_sha: shortSha(d.sha),
      message: d.message,
      trigger: d.trigger_kind,
      status: d.status,
      error: d.error || null,
      image_tag: d.image_tag,
      build_log: d.build_log || '',
      started: Number(d.started),
      finished: d.finished == null ? null : Number(d.finished),
      duration_ms: d.duration_ms == null ? null : Number(d.duration_ms),
      serving: Number(d.id) === Number(ctx.service.current_deployment_id),
    });
  }));

  api.post('/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId/cancel', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    res.json({ ok: await deployEngine.cancelDeployment(ctx.service.id) });
  }));

  api.post('/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId/redeploy', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    res.status(202).json(await deployEngine.redeploy(ctx.service.id, Number(req.params.depId)));
  }));

  api.post('/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId/rollback', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const dep = await deployEngine.rollback(ctx.service.id, Number(req.params.depId));
    res.status(202).json(dep);
  }));

  api.delete('/repos/:space/:repo/\\+/deployments/services/:id/deployments/:depId', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    await deployEngine.deleteDeployment(ctx.service.id, Number(req.params.depId));
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Live events (SSE): build/release log lines, status changes, metrics.
  // -------------------------------------------------------------------------

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/events', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const serviceId = ctx.service.id;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`data: ${JSON.stringify({ type: 'hello', serviceId })}\n\n`);

    const { subscribe } = await import('../lib/deployBus.js');
    const unsubscribe = subscribe(serviceId, evt => {
      try {
        res.write(`data: ${JSON.stringify(evt)}\n\n`);
      } catch {
        /* subscriber vanished mid-write */
      }
    });

    const heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n');
      } catch {
        /* closed */
      }
    }, 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }));

  // -------------------------------------------------------------------------
  // HTTP request logs (with preserve-failures defaults)
  // -------------------------------------------------------------------------

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/http-logs', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const serviceId = ctx.service.id;
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
    const minStatus = req.query.min_status ? Number(req.query.min_status) : null;
    const cls = ['2xx', '3xx', '4xx', '5xx'].includes(String(req.query.class))
      ? String(req.query.class)
      : null;
    const q = req.query.q ? String(req.query.q).slice(0, 200) : null;

    const where = ['service_id = $1'];
    const params = [serviceId];
    if (minStatus != null && !Number.isNaN(minStatus)) {
      params.push(minStatus);
      where.push(`(status_code >= $${params.length} OR status_code IS NULL)`);
    }
    if (cls) {
      params.push(Number(cls[0]), Number(cls[0]) + 99);
      where.push(`status_code BETWEEN $${params.length - 1} AND $${params.length}`);
    }
    if (q) {
      params.push(`%${q}%`);
      where.push(`path ILIKE $${params.length}`);
    }
    params.push(limit);
    const { rows } = await pool.query(
      `SELECT id, method, path, status_code, duration_ms, ts FROM deploy_http_logs
       WHERE ${where.join(' AND ')} ORDER BY ts DESC LIMIT $${params.length}`,
      params,
    );

    const { rows: counts } = await pool.query(
      `SELECT CASE WHEN status_code IS NULL THEN 'none'
                   WHEN status_code < 300 THEN '2xx'
                   WHEN status_code < 400 THEN '3xx'
                   WHEN status_code < 500 THEN '4xx'
                   ELSE '5xx' END AS class,
              COUNT(*)::int AS count
       FROM deploy_http_logs
       WHERE service_id = $1 AND ts > $2 GROUP BY 1`,
      [serviceId, Date.now() - 24 * 3600_000],
    );
    const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, none: 0 };
    for (const c of counts) byClass[c.class] = Number(c.count);

    res.json({
      logs: rows.map(r => ({
        id: Number(r.id),
        method: r.method,
        path: r.path,
        status_code: r.status_code == null ? null : Number(r.status_code),
        duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
        ts: Number(r.ts),
      })),
      counts_24h: byClass,
      preserve: {
        preserve_status_min: Number(ctx.service.preserve_status_min ?? 400),
        success_retention_hours: Number(ctx.service.success_retention_hours ?? 24),
        failure_retention_hours: Number(ctx.service.failure_retention_hours ?? 168),
      },
    });
  }));

  // -------------------------------------------------------------------------
  // Stats & uptime charts
  // -------------------------------------------------------------------------

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/stats', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    res.json({
      limits: {
        cpu_nano_cpus: Number(ctx.service.cpu_nano_cpus),
        memory_bytes: Number(ctx.service.memory_bytes),
      },
      ...deployEngine.getStatsSnapshot(ctx.service.id),
    });
  }));

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/uptime', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const ranges = {
      '24h': { spanMs: 24 * 3600_000, buckets: 90 },
      '7d': { spanMs: 7 * 24 * 3600_000, buckets: 91 },
      '30d': { spanMs: 30 * 24 * 3600_000, buckets: 90 },
    };
    const rangeKey = ranges[req.query.range] ? req.query.range : '24h';
    const { spanMs, buckets } = ranges[rangeKey];
    const end = Date.now();
    const start = end - spanMs;
    const bucketMs = Math.max(30_000, Math.floor(spanMs / buckets));

    const [{ rows: checks }, { rows: agg }] = await Promise.all([
      pool.query(
        'SELECT ok, latency_ms, ts FROM deploy_uptime_checks WHERE service_id = $1 AND ts >= $2 ORDER BY ts ASC',
        [ctx.service.id, start],
      ),
      pool.query(
        'SELECT COUNT(*)::int AS total, SUM(CASE WHEN ok THEN 1 ELSE 0 END)::int AS up FROM deploy_uptime_checks WHERE service_id = $1 AND ts >= $2',
        [ctx.service.id, start],
      ),
    ]);

    const outBuckets = [];
    const cursor = { idx: 0 };
    for (let b = 0; b < Math.ceil(spanMs / bucketMs); b++) {
      const bStart = start + b * bucketMs;
      const bEnd = Math.min(end, bStart + bucketMs);
      let state = 'empty';
      let maxLatency = null;
      while (cursor.idx < checks.length && checks[cursor.idx].ts < bEnd) {
        const c = checks[cursor.idx++];
        if (c.ts < bStart) continue;
        if (state === 'empty') state = c.ok ? 'up' : 'down';
        else if (!c.ok) state = 'down';
        if (c.latency_ms != null) maxLatency = Math.max(maxLatency || 0, Number(c.latency_ms));
      }
      outBuckets.push({ start: bStart, state, latency_ms: maxLatency });
    }

    const total = Number(agg[0]?.total || 0);
    const up = Number(agg[0]?.up || 0);
    res.json({
      range: rangeKey,
      bucket_ms: bucketMs,
      buckets: outBuckets,
      uptime_pct: total ? Math.round((up / total) * 10000) / 100 : null,
      checks_total: total,
    });
  }));

  // -------------------------------------------------------------------------
  // Custom domains + DNS guidance
  // -------------------------------------------------------------------------

  function domainGuidance(domain, kind) {
    const proxyPort = process.env.DEPLOY_PROXY_PORT || '3003';
    if (kind === 'tunnel') {
      return {
        dns: [
          {
            type: 'CNAME',
            name: domain.split('.').slice(0, domain.endsWith('.cfargotunnel.com') ? 0 : 1).join('.') || '@',
            target: cloudflareConfigured() ? tunnelCnameTarget() : '<TUNNEL-ID>.cfargotunnel.com',
            proxied: true,
          },
        ],
        notes: [
          cloudflareConfigured()
            ? 'This record is created/removed automatically via the Cloudflare API — no manual step needed.'
            : 'Create a Cloudflare Tunnel (Zero Trust → Networks → Tunnels) or run one with compose profile "tunnels".',
          'Add a public hostname mapping this domain to http://nixre-core:' + proxyPort + '.',
          'Point DNS at the tunnel with the CNAME shown.',
        ],
        cloudflared_ingress: [
          { hostname: domain, service: `http://nixre-core:${proxyPort}` },
        ],
      };
    }
    return {
      dns: [
        {
          type: 'A',
          name: '@',
          target: '<THIS-SERVER-IP>',
          note: 'Or AAAA for IPv6 / CNAME to another frontend that forwards here.',
        },
      ],
      notes: [
        `Forward requests for ${domain} to this server's port ${proxyPort}.`,
        `Host-level Caddy block:\n\n${domain} {\n  reverse_proxy 127.0.0.1:${proxyPort}\n}\n`,
        'TLS terminates at your host Caddy (automatic Let\'s Encrypt).',
      ],
      caddy_snippet: `${domain} {\n  reverse_proxy 127.0.0.1:${proxyPort}\n}`,
      nginx_snippet: `server {\n  server_name ${domain};\n  location / {\n    proxy_pass http://127.0.0.1:${proxyPort};\n    proxy_set_header Host $host;\n    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n    proxy_http_version 1.1;\n    proxy_set_header Upgrade $http_upgrade;\n    proxy_set_header Connection "upgrade";\n  }\n}`,
    };
  }

  // DNS status blob for a deploy_domains row. `auto` + status drive the UI
  // badge; `guidance` stays for manual setups and operator reference.
  function dnsStatus(row) {
    if (row.kind !== 'tunnel') return { auto: false, status: 'manual' };
    if (row.cf_record_id) {
      return { auto: true, status: 'created', target: tunnelCnameTarget() };
    }
    if (cloudflareConfigured()) return { auto: true, status: 'pending', target: tunnelCnameTarget() };
    return { auto: false, status: 'manual' };
  }

  // Best-effort: create the proxied CNAME for a tunnel domain via the
  // Cloudflare API and persist the record ids. Never throws — failures come
  // back as { auto: true, status: 'failed', error } so the UI can offer retry.
  async function provisionDns(row, domain) {
    if (!cloudflareConfigured()) return { auto: false, status: 'manual' };
    try {
      const result = await createTunnelCname(domain);
      await pool.query(
        'UPDATE deploy_domains SET cf_zone_id = $1, cf_record_id = $2 WHERE id = $3',
        [result.zoneId, result.recordId, row.id],
      );
      return {
        auto: true,
        status: 'created',
        target: tunnelCnameTarget(),
        zone: result.zoneName,
        existed: result.existed,
      };
    } catch (err) {
      return { auto: true, status: 'failed', target: tunnelCnameTarget(), error: String(err.message || err) };
    }
  }

  api.get('/repos/:space/:repo/\\+/deployments/services/:id/domains', auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT id, kind, domain, cf_zone_id, cf_record_id, created FROM deploy_domains WHERE service_id = $1 ORDER BY created',
      [ctx.service.id],
    );
    res.json(rows.map(r => ({
      id: Number(r.id),
      kind: r.kind,
      domain: r.domain,
      created: Number(r.created),
      dns: dnsStatus(r),
      guidance: domainGuidance(r.domain, r.kind),
    })));
  }));

  api.post('/repos/:space/:repo/\\+/deployments/services/:id/domains', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const domain = String(req.body?.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const kind = req.body?.kind === 'tunnel' ? 'tunnel' : 'caddy';
    if (!DOMAIN_RE.test(domain) || domain.includes('*')) {
      res.status(400).json({ message: 'Enter a concrete hostname like app.example.com' });
      return;
    }
    const { rows: taken } = await pool.query(
      'SELECT 1 FROM deploy_domains WHERE domain = $1',
      [domain],
    );
    if (taken.length) {
      res.status(409).json({ message: 'That domain is already routed on this instance' });
      return;
    }
    const { rows } = await pool.query(
      'INSERT INTO deploy_domains (service_id, kind, domain, created) VALUES ($1,$2,$3,$4) RETURNING id',
      [ctx.service.id, kind, domain, Date.now()],
    );
    const row = { id: rows[0].id, kind, domain };
    const dns = await provisionDns(row, domain);
    await proxyInvalidate();
    res.status(201).json({
      id: Number(rows[0].id),
      kind,
      domain,
      dns,
      guidance: domainGuidance(domain, kind),
    });
  }));

  // Retry Cloudflare record creation for a tunnel domain whose first attempt
  // failed (expired token, zone not visible yet, transient API error, …).
  api.post('/repos/:space/:repo/\\+/deployments/services/:id/domains/:domainId/dns', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT id, kind, domain, cf_zone_id, cf_record_id FROM deploy_domains WHERE id = $1 AND service_id = $2',
      [Number(req.params.domainId), ctx.service.id],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Domain not found' });
      return;
    }
    if (row.kind !== 'tunnel') {
      res.status(400).json({ message: 'DNS automation only applies to Cloudflare Tunnel domains' });
      return;
    }
    if (!cloudflareConfigured()) {
      res.status(400).json({ message: 'Cloudflare DNS automation is not configured on this instance' });
      return;
    }
    const dns = await provisionDns(row, row.domain);
    await proxyInvalidate();
    res.json({ id: Number(row.id), domain: row.domain, dns, guidance: domainGuidance(row.domain, row.kind) });
  }));

  api.delete('/repos/:space/:repo/\\+/deployments/services/:id/domains/:domainId', auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT id, kind, domain, cf_zone_id, cf_record_id FROM deploy_domains WHERE id = $1 AND service_id = $2',
      [Number(req.params.domainId), ctx.service.id],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Domain not found' });
      return;
    }
    await pool.query('DELETE FROM deploy_domains WHERE id = $1 AND service_id = $2', [
      Number(req.params.domainId),
      ctx.service.id,
    ]);
    await proxyInvalidate();
    // Clean up the Cloudflare record we created. Best effort — the row is
    // already gone, so a failed delete only surfaces as a warning field.
    let dns = { removed: false };
    if (row.cf_zone_id && row.cf_record_id) {
      try {
        await deleteDnsRecord(row.cf_zone_id, row.cf_record_id);
        dns = { removed: true };
      } catch (err) {
        dns = { removed: false, error: String(err.message || err) };
      }
    }
    res.json({ ok: true, dns });
  }));

  // -------------------------------------------------------------------------
  // Space-wide deployments board (Railway-style cards + activity feed).
  // Visible when the space itself is visible: public, membership, personal
  // ownership, or admin.
  // -------------------------------------------------------------------------

  api.get('/spaces/:uid/deployments', auth, guard(async (req, res) => {
    const user = req.auth.user;
    const { rows: spaceRows } = await pool.query(
      `SELECT sp.uid, sp.is_public, sp.uid AS owner_uid FROM spaces sp WHERE sp.uid = $1`,
      [req.params.uid],
    );
    const space = spaceRows[0];
    if (!space) {
      res.status(404).json({ message: 'Space not found' });
      return;
    }
    if (!user.admin && !space.is_public) {
      const { rows: member } = await pool.query(
        'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
        [space.uid, user.uid],
      );
      if (!member.length && space.owner_uid !== user.uid) {
        res.status(403).json({ message: 'No access to this space' });
        return;
      }
    }

    const { rows: services } = await pool.query(
      `SELECT s.*, r.uid AS repo_uid, r.default_branch
       FROM deploy_services s
       JOIN repos r ON r.id = s.repo_id
       WHERE r.space_uid = $1
       ORDER BY s.created ASC`,
      [space.uid],
    );

    const domainsByService = new Map();
    if (services.length) {
      const ids = services.map(s => s.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: domainRows } = await pool.query(
        `SELECT service_id, domain FROM deploy_domains WHERE service_id IN (${placeholders}) ORDER BY created`,
        ids,
      );
      for (const d of domainRows) {
        const list = domainsByService.get(Number(d.service_id)) || [];
        list.push(d.domain);
        domainsByService.set(Number(d.service_id), list);
      }
    }

    const out = [];
    for (const s of services) {
      const summary = await currentDeploymentSummary(s);
      out.push(rowToService(s, {
        current: summary,
        repo_uid: s.repo_uid,
        alert: s.last_failed_deployment_id != null,
        domains: domainsByService.get(Number(s.id)) || [],
      }));
    }

    // Activity feed: latest deployments across the space's services.
    let activity = [];
    if (out.length) {
      const ids = services.map(s => s.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: acts } = await pool.query(
        `SELECT d.id, d.service_id, d.ref, d.sha, d.status, d.trigger_kind, d.started, d.finished, s.name AS service_name
         FROM deployments d
         JOIN deploy_services s ON s.id = d.service_id
         WHERE d.service_id IN (${placeholders})
         ORDER BY d.started DESC
         LIMIT 30`,
        ids,
      );
      activity = acts.map(a => ({
        id: Number(a.id),
        service_id: Number(a.service_id),
        service_name: a.service_name,
        ref: a.ref,
        short_sha: shortSha(a.sha),
        status: a.status,
        trigger: a.trigger_kind,
        started: Number(a.started),
        finished: a.finished == null ? null : Number(a.finished),
      }));
    }

    res.json({ services: out, activity });
  }));

  // -------------------------------------------------------------------------
  // Dashboard overview — most active deployments across visible spaces.
  // -------------------------------------------------------------------------

  api.get('/deployments/overview', auth, guard(async (req, res) => {
    const user = req.auth.user;
    // Services in spaces the user can read: public spaces, memberships,
    // personal spaces owned by them (space uid == owner uid), or admin.
    const visibility = user.admin
      ? 'TRUE'
      : `EXISTS (
           SELECT 1 FROM repos r
           JOIN spaces sp ON sp.uid = r.space_uid
           LEFT JOIN space_members m ON m.space_uid = r.space_uid AND m.user_uid = $1
           WHERE r.id = s.repo_id AND (sp.is_public OR m.user_uid IS NOT NULL OR sp.uid = $1)
         )`;
    const { rows: services } = await pool.query(
      `SELECT s.*, r.space_uid AS space, r.uid AS repo_uid, r.default_branch
       FROM deploy_services s
       JOIN repos r ON r.id = s.repo_id
       JOIN spaces sp ON sp.uid = r.space_uid
       WHERE ${visibility}`,
      [user.uid],
    );

    const ids = services.map(s => s.id);
    const reqCounts = new Map();
    if (ids.length) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows } = await pool.query(
        `SELECT service_id, COUNT(*)::int AS n FROM deploy_http_logs
         WHERE service_id IN (${placeholders}) AND ts > $${ids.length + 1}
         GROUP BY service_id`,
        [...ids, Date.now() - 24 * 3600_000],
      );
      for (const r of rows) reqCounts.set(Number(r.service_id), Number(r.n));
    }

    const out = [];
    for (const s of services) {
      const summary = await currentDeploymentSummary(s);
      const failed = s.last_failed_deployment_id != null;
      const live =
        s.desired_state === 'running' && Boolean(summary) && summary.status === 'live';
      out.push({
        ...rowToService(s, {
          current: summary,
          requests_24h: reqCounts.get(Number(s.id)) || 0,
          alert: failed,
          live,
        }),
        space: s.space,
        repo_uid: s.repo_uid,
      });
    }
    out.sort((a, b) => b.requests_24h - a.requests_24h);
    res.json(out.slice(0, 20));
  }));

  return api;
}

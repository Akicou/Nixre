// Deployment routes — services, env vars, deploys, logs, uptime, domains.
//
// Space-scoped services with shipped repo aliases. Repo reads follow repo
// visibility; standalone reads and all writes require membership or admin.

import express from 'express';
import { encryptSecret } from '../lib/ai.js';
import { deployEngine, getDeployProxy } from '../lib/deployRuntime.js';
import { listTree as gitListTree } from '../lib/deployDrivers.js';
import { canReadRepo } from '../lib/repoAccess.js';
import { externalGitHosts } from '../lib/deployGit.js';
import { validateServiceConfig, validateServiceEnv, validateDeployRef } from '../lib/deployServiceConfig.js';
import {
  filterDockerfiles,
  normalizeRootDir,
  shortSha,
} from '../lib/deployPure.js';
import {
  runtimeFlagsFromEnv,
} from '../lib/deployRuntimeOptions.js';
import {
  cloudflareConfigured,
  createTunnelCname,
  deleteDnsRecord,
  findZoneId,
  tunnelCnameTarget,
} from '../lib/cloudflareDns.js';
import {
  newVerifyToken,
  verifyRecordName,
  checkDomainChallenge,
  reservedDomainSet,
  reservedDomainReason,
} from '../lib/domainVerify.js';

const DOMAIN_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

// Bound the number of hostnames one service can claim.
const MAX_DOMAINS_PER_SERVICE = 20;

// Bound the number of services per repository. Each one reserves memory/CPU
// limits and gets a container, so an uncapped count lets any space member
// reserve unbounded host resources.
const MAX_SERVICES_PER_REPO = Number(process.env.DEPLOY_MAX_SERVICES_PER_REPO || 20);

export function deploymentRoutes(pool, authenticate, {
  engine = deployEngine, listTree = gitListTree, proxy = getDeployProxy,
  env = process.env, validateGitUrl,
} = {}) {
  const api = express.Router();
  const serviceWrites = new Set();
  const auth = [authenticate(true), (req, res, next) => {
    if (!req.auth?.user) return res.status(401).json({ message: 'Authentication required' });
    if (req.auth.user.blocked) return res.status(403).json({ message: 'This account is blocked' });
    next();
  }];
  const servicePaths = (suffix = '') => [
    `/spaces/:space/deployments/services${suffix}`,
    `/repos/:space/:repo/\\+/deployments/services${suffix}`,
  ];

  async function loadRepo(req, res) {
    const { space, repo } = req.params;
    const { rows } = await pool.query('SELECT * FROM repos WHERE space_uid = $1 AND uid = $2', [
      space,
      repo,
    ]);
    if (!rows[0] || !(await canReadRepo(pool, rows[0], req.auth.user))) {
      res.status(404).json({ message: 'Repository not found' });
      return null;
    }
    return rows[0];
  }

  async function canWrite(spaceUid, user) {
    if (!user || user.blocked) return false;
    if (user.admin) return true;
    const { rows } = await pool.query(
      'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
      [spaceUid, user.uid],
    );
    return rows.length > 0;
  }

  async function requireWriter(req, res) {
    const owner = req.params.repo ? await loadRepo(req, res) : await loadSpace(req, res);
    if (!owner) return null;
    if (!(await canWrite(req.params.space, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    return owner;
  }

  async function loadSpace(req, res) {
    const { rows } = await pool.query('SELECT * FROM spaces WHERE uid = $1', [req.params.space]);
    const space = rows[0];
    if (!space || (!space.is_public && !(await canWrite(space.uid, req.auth.user)))) {
      res.status(404).json({ message: 'Space not found' });
      return null;
    }
    return space;
  }

  async function loadService(req, res, { allowLatestCancellation = false } = {}) {
    let repo = req.params.repo ? await loadRepo(req, res) : null;
    if (req.params.repo && !repo) return null;
    // Routes define the service param as ':id'; reject non-numeric ids with a
    // 404 instead of letting Number() produce NaN and blow up in Postgres.
    const serviceId = Number(req.params.id);
    if (!Number.isSafeInteger(serviceId) || serviceId <= 0) {
      res.status(404).json({ message: 'Service not found' });
      return null;
    }
    const { rows } = repo ? await pool.query(
      'SELECT * FROM deploy_services WHERE id = $1 AND repo_id = $2', [serviceId, repo.id],
    ) : await pool.query(
      `SELECT s.*, COALESCE(s.space_uid, r.space_uid) AS space_uid, to_jsonb(r) AS repo
       FROM deploy_services s LEFT JOIN repos r ON r.id = s.repo_id
       WHERE s.id = $1 AND COALESCE(s.space_uid, r.space_uid) = $2`, [serviceId, req.params.space],
    );
    const service = rows[0];
    repo ||= service?.repo;
    if (!service || (service.space_uid ?? repo?.space_uid) !== req.params.space
      || (req.params.repo && Number(service.repo_id) !== Number(repo.id))
      || !(repo ? await canReadRepo(pool, repo, req.auth.user) : await canWrite(service.space_uid, req.auth.user))) {
      res.status(404).json({ message: 'Service not found' });
      return null;
    }
    // Child IDs must belong to this service even for engine-backed actions
    // (notably cancel, whose engine API only receives the service ID).
    for (const [param, table, label] of [['depId', 'deployments', 'Deployment'], ['domainId', 'deploy_domains', 'Domain']]) {
      if (req.params[param] === undefined) continue;
      // Both shipped UIs address the active run by this sentinel. Only the
      // POST cancellation handler opts in; all other child IDs stay scoped.
      if (allowLatestCancellation && req.method === 'POST' && param === 'depId' && req.params[param] === 'latest') continue;
      const id = Number(req.params[param]);
      if (!Number.isSafeInteger(id) || id <= 0 || !(await pool.query(
        `SELECT id FROM ${table} WHERE id = $1 AND service_id = $2`, [id, service.id],
      )).rows.length) {
        res.status(404).json({ message: `${label} not found` });
        return null;
      }
    }
    return { repo: repo || null, service, space_uid: service.space_uid ?? repo.space_uid };
  }

  async function requireServiceWriter(req, res, options) {
    const ctx = await loadService(req, res, options);
    if (!ctx) return null;
    if (!(await canWrite(ctx.space_uid, req.auth.user))) {
      res.status(403).json({ message: 'No write access' });
      return null;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const key = String(ctx.service.id);
      if (serviceWrites.has(key)) {
        res.status(409).json({ message: 'A service mutation is already running' });
        return null;
      }
      // Span engine stop AND metadata deletion. Engine lifecycle locking alone
      // would admit a manual deploy between these two awaited operations.
      serviceWrites.add(key);
      req.deploymentWriteLock = key;
    }
    return ctx;
  }

  // An in-flight error shaped {status} maps onto the response cleanly.
  function guard(fn) {
    return (req, res) => {
      fn(req, res).catch(err => {
        const status = err?.code === '23505' ? 409 : err?.status || 500;
        if (status >= 500) console.error('deployments route:', err);
        if (res.headersSent) { res.end(); return; }
        res.status(status).json({ message: err?.code === '23505' ? 'A service or domain with that name already exists' : err?.message || 'Deployment error' });
      }).finally(() => {
        if (req.deploymentWriteLock !== undefined) serviceWrites.delete(req.deploymentWriteLock);
      });
    };
  }

  async function proxyInvalidate() {
    proxy()?.invalidateRoutes();
  }

  function rowToService(s, extra = {}) {
    return {
      id: Number(s.id),
      space_uid: s.space_uid ?? s.repo?.space_uid ?? null,
      repo_id: s.repo_id == null ? null : Number(s.repo_id),
      repo_uid: s.repo_uid ?? s.repo?.uid ?? null,
      source_type: s.source_type ?? 'repo',
      git_url: s.git_url ?? null,
      image_ref: s.image_ref ?? null,
      build_target: s.build_target ?? null,
      template: s.template ?? null,
      exposure: s.exposure ?? 'http',
      deployment_strategy: s.deployment_strategy ?? 'blue_green',
      volume_path: s.volume_path ?? null,
      internal_hostname: s.deployment_strategy === 'recreate' ? `nixre-svc-${s.id}` : null,
      volume_name: s.volume_path ? `nixre-service-${s.id}-data` : null,
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
      runtime_options: s.runtime_options ?? null,
      security_policy_version: Number(s.security_policy_version ?? 1),
      created: Number(s.created),
      updated: Number(s.updated),
      ...extra,
    };
  }

  async function currentDeploymentSummary(service) {
    if (!service.current_deployment_id) return null;
    const { rows } = await pool.query(
      'SELECT id, ref, sha, message, status, trigger_kind, started, finished FROM deployments WHERE id = $1 AND service_id = $2',
      [service.current_deployment_id, service.id],
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

  async function visibleServices(user, spaceUid) {
    const { rows } = await pool.query(
      `SELECT s.*, COALESCE(s.space_uid, r.space_uid) AS space_uid, r.uid AS repo_uid, to_jsonb(r) AS repo
       FROM deploy_services s LEFT JOIN repos r ON r.id = s.repo_id
       ${spaceUid ? 'WHERE COALESCE(s.space_uid, r.space_uid) = $1' : ''} ORDER BY s.created ASC`,
      spaceUid ? [spaceUid] : [],
    );
    const visible = [];
    const writers = new Map();
    for (const s of rows) {
      if (!writers.has(s.space_uid)) writers.set(s.space_uid, await canWrite(s.space_uid, user));
      const writer = writers.get(s.space_uid);
      if (s.repo_id != null ? await canReadRepo(pool, s.repo, user) : writer) visible.push({ ...s, can_write: writer });
    }
    return visible;
  }

  async function transaction(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally { client.release(); }
  }

  async function writeEnv(client, id, vars) {
    for (const [key, value] of Object.entries(vars)) {
      if (value === null) await client.query('DELETE FROM service_env_vars WHERE service_id = $1 AND key = $2', [id, key]);
      else await client.query(
        `INSERT INTO service_env_vars (service_id, key, value_enc, updated) VALUES ($1,$2,$3,$4)
         ON CONFLICT (service_id, key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated = EXCLUDED.updated`,
        [id, key, encryptSecret(value), Date.now()],
      );
    }
  }

  api.get(servicePaths(), auth, guard(async (req, res) => {
    let rows;
    if (req.params.repo) {
      const repo = await loadRepo(req, res);
      if (!repo) return;
      rows = (await pool.query('SELECT * FROM deploy_services WHERE repo_id = $1 ORDER BY created ASC', [repo.id])).rows
        .map(s => ({ ...s, space_uid: s.space_uid ?? repo.space_uid, repo, can_write: false }));
      const writer = await canWrite(repo.space_uid, req.auth.user);
      for (const s of rows) s.can_write = writer;
    } else {
      if (!(await loadSpace(req, res))) return;
      rows = await visibleServices(req.auth.user, req.params.space);
    }
    const out = [];
    for (const s of rows) {
      out.push(rowToService(s, { current: await currentDeploymentSummary(s), can_write: s.can_write }));
    }
    res.json(out);
  }));

  api.get(servicePaths('/:id'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    res.json(rowToService({ ...ctx.service, space_uid: ctx.space_uid, repo: ctx.repo }, {
      current: await currentDeploymentSummary(ctx.service), can_write: await canWrite(ctx.space_uid, req.auth.user),
    }));
  }));

  api.post(servicePaths(), auth, guard(async (req, res) => {
    const owner = await requireWriter(req, res);
    if (!owner) return;
    const repo = req.params.repo ? owner : null;
    const body = req.body || {};
    if (Object.hasOwn(body, 'security_policy_version')) {
      res.status(req.auth.user.admin ? 400 : 403).json({
        message: 'New services use the current security policy; only an instance admin can change an existing service via PATCH',
      });
      return;
    }
    const { config, vars } = await validateServiceConfig(body, { repo, admin: Boolean(req.auth.user.admin), env, validateGitUrl });
    if (repo) {
      let tree;
      const ref = body.ref ?? config.branch;
      try { tree = await listTree(repo.space_uid, repo.uid, ref); }
      catch (err) { throw Object.assign(new Error(`Cannot read ${ref}: ${err.message}`), { status: 400 }); }
      const found = filterDockerfiles(tree, config.root_dir);
      if (!found.some(d => d.file === config.dockerfile_path)) {
        res.status(400).json({ message: `Dockerfile '${config.dockerfile_path}' not found under ${config.root_dir}`, dockerfiles: found });
        return;
      }
    }
    // Serialize quota checks per owner and commit metadata + encrypted env on
    // one client. External source creation does not clone, pull or deploy.
    const service = await transaction(async client => {
      await client.query(repo ? 'SELECT id FROM repos WHERE id = $1 FOR UPDATE' : 'SELECT uid FROM spaces WHERE uid = $1 FOR UPDATE', [repo?.id ?? owner.uid]);
      const { rows: count } = await client.query(repo
        ? 'SELECT count(*)::int AS n FROM deploy_services WHERE repo_id = $1'
        : 'SELECT count(*)::int AS n FROM deploy_services WHERE space_uid = $1 AND repo_id IS NULL', [repo?.id ?? owner.uid]);
      if (Number(count[0]?.n || 0) >= MAX_SERVICES_PER_REPO) throw Object.assign(new Error(`At most ${MAX_SERVICES_PER_REPO} services per ${repo ? 'repository' : 'standalone space'}`), { status: 409 });
      const data = { repo_id: repo?.id ?? null, ...config, space_uid: req.params.space, created_by: req.auth.user.uid, created: Date.now(), updated: Date.now() };
      const keys = Object.keys(data);
      const { rows } = await client.query(`INSERT INTO deploy_services (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`, Object.values(data));
      await writeEnv(client, rows[0].id, vars);
      return rows[0];
    });
    res.status(201).json(rowToService(service, { current: null, can_write: true }));
  }));

  api.patch(servicePaths('/:id'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { service } = ctx;
    const body = req.body || {};
    // Validate before processing env updates or other side effects. A policy
    // downgrade requires an explicit admin request, never a reset of options.
    if (Object.hasOwn(body, 'security_policy_version')) {
      if (!req.auth.user.admin) {
        res.status(403).json({ message: 'Only an instance admin can change the deployment security policy' });
        return;
      }
      if (body.security_policy_version !== 1 && body.security_policy_version !== 2) {
        res.status(400).json({ message: 'security_policy_version must be the number 1 or 2' });
        return;
      }
    }

    const { config, vars } = await validateServiceConfig(body, { service, admin: Boolean(req.auth.user.admin), env, validateGitUrl });
    const want = config.desired_state;
    delete config.desired_state;
    await transaction(async client => {
      if (Object.keys(config).length) {
        config.updated = Date.now();
        const entries = Object.entries(config);
        await client.query(`UPDATE deploy_services SET ${entries.map(([key], i) => `${key} = $${i + 1}`).join(', ')} WHERE id = $${entries.length + 1}`, [...entries.map(([, v]) => v), service.id]);
      }
      await writeEnv(client, service.id, vars);
    });
    // The engine serializes stop with in-flight work. Never swallow failures
    // or remove metadata while a container writer may still be alive.
    if (want === 'stopped') await engine.stopService(service.id);
    else if (want === 'running' && want !== service.desired_state) await engine.startService(service.id);
    await proxyInvalidate();

    const fresh = (
      await pool.query('SELECT * FROM deploy_services WHERE id = $1', [service.id])
    ).rows[0];
    res.json(rowToService({ ...fresh, space_uid: ctx.space_uid, repo: ctx.repo }, { current: await currentDeploymentSummary(fresh), can_write: true }));
  }));

  api.delete(servicePaths('/:id'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const { service } = ctx;
    // stopService must cancel and await active work, including a first build
    // without a current pointer. Managed volumes are deliberately retained.
    await engine.stopService(service.id);
    await pool.query('DELETE FROM deploy_services WHERE id = $1', [service.id]);
    await proxyInvalidate();
    res.json({ ok: true });
  }));

  // Dockerfile detection for the wizard — never guesses, only reports.
  api.get('/repos/:space/:repo/\\+/deployments/dockerfiles', auth, guard(async (req, res) => {
    const repo = await loadRepo(req, res);
    if (!repo) return;
    const ref = validateDeployRef(req.query.ref || repo.default_branch || 'main');
    let rootDir = '.';
    try {
      rootDir = normalizeRootDir(String(req.query.root_dir || '.'));
    } catch {
      res.status(400).json({ message: 'root_dir may not traverse upwards' });
      return;
    }
    try {
      const tree = await listTree(repo.space_uid, repo.uid, ref);
      res.json({ ref, root_dir: rootDir, dockerfiles: filterDockerfiles(tree, rootDir) });
    } catch (err) {
      res.status(400).json({ message: `Cannot read ${ref}: ${err.message}` });
    }
  }));

  // -------------------------------------------------------------------------
  // Env vars (Railway-style groups)
  // -------------------------------------------------------------------------

  api.get(servicePaths('/:id/env'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const { rows } = await pool.query(
      'SELECT key, updated FROM service_env_vars WHERE service_id = $1 ORDER BY key',
      [ctx.service.id],
    );
    res.json(rows.map(r => ({ key: r.key, updated: Number(r.updated) })));
  }));

  api.put(servicePaths('/:id/env'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const vars = validateServiceEnv(req.body?.vars, { template: ctx.service.template });
    const keys = Object.keys(vars);
    await transaction(async client => {
      // Template initialization secrets cannot be removed by full replacement.
      await client.query(ctx.service.template === 'postgres'
        ? "DELETE FROM service_env_vars WHERE service_id = $1 AND key NOT IN ('POSTGRES_DB', 'POSTGRES_USER', 'POSTGRES_PASSWORD')"
        : 'DELETE FROM service_env_vars WHERE service_id = $1', [ctx.service.id]);
      await writeEnv(client, ctx.service.id, vars);
    });
    res.json({ ok: true, keys });
  }));

  // Deleting one variable must not require replaying every other secret's
  // plaintext (PUT is intentionally full-replace; deletes are surgical).
  api.delete(
    servicePaths('/:id/env/:key'),
    auth,
    guard(async (req, res) => {
      const ctx = await requireServiceWriter(req, res);
      if (!ctx) return;
      validateServiceEnv({ [req.params.key]: null }, { allowNull: true, template: ctx.service.template });
      await pool.query('DELETE FROM service_env_vars WHERE service_id = $1 AND key = $2', [
        ctx.service.id,
        req.params.key,
      ]);
      res.json({ ok: true });
    }),
  );

  api.get(
    servicePaths('/:id/env/:key/reveal'),
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

  api.post(servicePaths('/:id/deploy'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    if (req.body !== undefined && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(k => k !== 'ref'))) {
      res.status(400).json({ message: 'Deploy accepts only an optional ref' });
      return;
    }
    const ref = req.body?.ref === undefined ? undefined : validateDeployRef(req.body.ref);
    if (ctx.service.source_type === 'image' && ref !== undefined) {
      res.status(400).json({ message: 'Image deployments do not accept a Git ref' });
      return;
    }
    const out = await engine.startDeployment(ctx.service.id, { ref, trigger: 'manual' });
    res.status(202).json(out);
  }));

  api.get(servicePaths('/:id/deployments'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const limit = queryInteger(req.query.limit, 30, 1, 100);
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

  api.get(servicePaths('/:id/deployments/:depId'), auth, guard(async (req, res) => {
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

  api.post(servicePaths('/:id/deployments/:depId/cancel'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res, { allowLatestCancellation: true });
    if (!ctx) return;
    res.json({ ok: await engine.cancelDeployment(ctx.service.id) });
  }));

  api.post(servicePaths('/:id/deployments/:depId/redeploy'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    res.status(202).json(await engine.redeploy(ctx.service.id, Number(req.params.depId)));
  }));

  api.post(servicePaths('/:id/deployments/:depId/rollback'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const dep = await engine.rollback(ctx.service.id, Number(req.params.depId));
    res.status(202).json(dep);
  }));

  api.delete(servicePaths('/:id/deployments/:depId'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    await engine.deleteDeployment(ctx.service.id, Number(req.params.depId));
    res.json({ ok: true });
  }));

  // -------------------------------------------------------------------------
  // Live events (SSE): build/release log lines, status changes, metrics.
  // -------------------------------------------------------------------------

  api.get(servicePaths('/:id/events'), auth, guard(async (req, res) => {
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

  function queryInteger(raw, fallback, min, max) {
    if (raw === undefined) return fallback;
    const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(n) || n < min || n > max) throw Object.assign(new Error(`Expected integer between ${min} and ${max}`), { status: 400 });
    return n;
  }

  api.get(servicePaths('/:id/runtime-logs'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    const tail = queryInteger(req.query.tail, 200, 1, 1000);
    res.json({ logs: await engine.runtimeLogs(ctx.service.id, { tail }) });
  }));

  api.get(servicePaths('/:id/http-logs'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    const serviceId = ctx.service.id;
    const limit = queryInteger(req.query.limit, 200, 1, 1000);
    const minStatus = req.query.min_status === undefined ? null : queryInteger(req.query.min_status, null, 100, 599);
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
      params.push(Number(cls[0]) * 100, Number(cls[0]) * 100 + 99);
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

  api.get(servicePaths('/:id/stats'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    res.json({
      limits: {
        cpu_nano_cpus: Number(ctx.service.cpu_nano_cpus),
        memory_bytes: Number(ctx.service.memory_bytes),
      },
      ...engine.getStatsSnapshot(ctx.service.id),
    });
  }));

  api.get(servicePaths('/:id/uptime'), auth, guard(async (req, res) => {
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
            ? 'An instance admin can provision this record via the Cloudflare API. Other users must publish DNS and the TXT ownership challenge themselves.'
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
  function verificationStatus(row) {
    if (row.verified === true) return { verified: true };
    return {
      verified: false,
      method: 'txt',
      record: { type: 'TXT', name: verifyRecordName(row.domain), value: row.verify_token },
    };
  }

  function dnsStatus(row, user) {
    if (row.kind !== 'tunnel') return { auto: false, status: 'manual' };
    if (row.cf_record_id) {
      return { auto: true, status: 'created', target: tunnelCnameTarget() };
    }
    if (cloudflareConfigured() && user?.admin) return { auto: true, status: 'pending', target: tunnelCnameTarget() };
    return { auto: false, status: 'manual' };
  }

  // Best-effort: create the proxied CNAME for a tunnel domain via the
  // Cloudflare API and persist the record ids. Never throws — failures come
  // back as { auto: true, status: 'failed', error } so the UI can offer retry.
  async function provisionDns(row, domain, user) {
    if (row.kind !== 'tunnel' || !user?.admin || !cloudflareConfigured()) return { auto: false, status: 'manual' };
    try {
      const result = await createTunnelCname(domain);
      await pool.query(
        'UPDATE deploy_domains SET cf_zone_id = $1, cf_record_id = $2, verified = TRUE, verified_at = $4 WHERE id = $3',
        [result.zoneId, result.recordId, row.id, Date.now()],
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

  function requireHttp(ctx, res) {
    if (ctx.service.exposure !== 'internal') return true;
    res.status(400).json({ message: 'Internal services cannot have public domains or DNS automation' });
    return false;
  }

  api.get(servicePaths('/:id/domains'), auth, guard(async (req, res) => {
    const ctx = await loadService(req, res);
    if (!ctx) return;
    if (ctx.service.exposure === 'internal') { res.json([]); return; }
    const { rows } = await pool.query(
      `SELECT id, kind, domain, tls_risk, verified, verify_token, cf_zone_id, cf_record_id, created
       FROM deploy_domains WHERE service_id = $1 ORDER BY created`,
      [ctx.service.id],
    );
    res.json(rows.map(r => ({
      id: Number(r.id),
      kind: r.kind,
      domain: r.domain,
      tls_risk: Boolean(r.tls_risk),
      verified: Boolean(r.verified),
      verification: verificationStatus(r),
      created: Number(r.created),
      dns: dnsStatus(r, req.auth.user),
      guidance: domainGuidance(r.domain, r.kind),
    })));
  }));

  api.post(servicePaths('/:id/domains'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    if (!requireHttp(ctx, res)) return;
    const domain = String(req.body?.domain || '').trim().toLowerCase().replace(/\.$/, '');
    const kind = req.body?.kind === 'tunnel' ? 'tunnel' : 'caddy';
    if (domain.length > 253 || domain.split('.').some(label => label.length > 63) || !DOMAIN_RE.test(domain) || domain.includes('*')) {
      res.status(400).json({ message: 'Enter a concrete hostname like app.example.com' });
      return;
    }

    // Hostname hijacking guard. Custom domains are matched before every other
    // routing rule, so without this a space member could attach the forge's
    // own hostname (or any third-party domain) and serve their container from
    // it.
    const reservedReason = reservedDomainReason(domain, {
      baseDomain: process.env.DEPLOY_BASE_DOMAIN || '',
      reserved: reservedDomainSet(),
    });
    if (reservedReason) {
      res.status(409).json({ message: reservedReason });
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

    const { rows: existing } = await pool.query(
      'SELECT count(*)::int AS n FROM deploy_domains WHERE service_id = $1',
      [ctx.service.id],
    );
    if (Number(existing[0]?.n || 0) >= MAX_DOMAINS_PER_SERVICE) {
      res
        .status(409)
        .json({ message: `A service can attach at most ${MAX_DOMAINS_PER_SERVICE} domains` });
      return;
    }

    // TLS depth check (tunnel kind): Cloudflare Universal SSL covers only one
    // level of subdomain per zone on free plans — a.b.example.com gets TLS
    // handshake failures. Require an explicit confirmation for those instead
    // of silently attaching something that won't serve HTTPS.
    let tlsRisk = false;
    if (kind === 'tunnel' && req.auth.user.admin && cloudflareConfigured()) {
      try {
        const zone = await findZoneId(domain);
        const depth = domain.split('.').length - zone.zoneName.split('.').length;
        if (depth > 1) {
          tlsRisk = true;
          if (!req.body?.confirm) {
            res.status(409).json({
              code: 'TLS_DEPTH_CONFIRMATION',
              depth,
              zone: zone.zoneName,
              message:
                `${domain} sits ${depth} levels under ${zone.zoneName}. Cloudflare Universal SSL (free plans) ` +
                `covers only one level of subdomain, so HTTPS would fail for visitors with a TLS handshake error. ` +
                `Use a single-level name under the zone, or attach anyway if you know TLS is handled (paid plan / ACM).`,
            });
            return;
          }
        }
      } catch {
        // Zone not visible to the token — no TLS verdict; auto-DNS will
        // surface its own error downstream if applicable.
      }
    }

    const verifyToken = newVerifyToken();
    const { rows } = await pool.query(
      `INSERT INTO deploy_domains
         (service_id, kind, domain, tls_risk, verified, verify_token, created)
       VALUES ($1,$2,$3,$4,FALSE,$5,$6) RETURNING id`,
      [ctx.service.id, kind, domain, tlsRisk, verifyToken, Date.now()],
    );
    const row = { id: rows[0].id, kind, domain };
    const dns = await provisionDns(row, domain, req.auth.user);

    // Only an admin may provision with operator credentials. Other claims
    // remain parked until their independently published TXT proof matches.
    const verified = dns.status === 'created';
    await proxyInvalidate();

    res.status(201).json({
      id: Number(row.id),
      kind,
      domain,
      tls_risk: tlsRisk,
      verified,
      verification: verified
        ? { verified: true }
        : {
            verified: false,
            method: 'txt',
            record: {
              type: 'TXT',
              name: verifyRecordName(domain),
              value: verifyToken,
            },
          },
      dns,
      guidance: domainGuidance(domain, kind),
    });
  }));

  // POST .../domains/:domainId/verify — prove ownership with the TXT
  // challenge, or (admin) mark a domain verified out of band.
  api.post(servicePaths('/:id/domains/:domainId/verify'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    if (!requireHttp(ctx, res)) return;
    const { rows } = await pool.query(
      'SELECT id, domain, verified, verify_token FROM deploy_domains WHERE id = $1 AND service_id = $2',
      [Number(req.params.domainId), ctx.service.id],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Domain not found' });
      return;
    }
    const reservedReason = reservedDomainReason(row.domain, {
      baseDomain: process.env.DEPLOY_BASE_DOMAIN || '', reserved: reservedDomainSet(),
    });
    if (reservedReason) { res.status(409).json({ message: reservedReason }); return; }
    if (row.verified) {
      res.json({ id: Number(row.id), domain: row.domain, verified: true });
      return;
    }

    if (req.body?.force === true) {
      if (!req.auth.user.admin) {
        res.status(403).json({ message: 'Only an instance admin can skip domain verification' });
        return;
      }
      await pool.query(
        'UPDATE deploy_domains SET verified = TRUE, verified_at = $2 WHERE id = $1',
        [row.id, Date.now()],
      );
      await proxyInvalidate();
      res.json({ id: Number(row.id), domain: row.domain, verified: true, method: 'admin' });
      return;
    }

    const check = await checkDomainChallenge(row.domain, row.verify_token);
    if (!check.ok) {
      res.status(409).json({
        code: 'DOMAIN_VERIFICATION_FAILED',
        verified: false,
        message: check.detail,
        record: {
          type: 'TXT',
          name: verifyRecordName(row.domain),
          value: row.verify_token,
        },
      });
      return;
    }
    await pool.query(
      'UPDATE deploy_domains SET verified = TRUE, verified_at = $2 WHERE id = $1',
      [row.id, Date.now()],
    );
    await proxyInvalidate();
    res.json({ id: Number(row.id), domain: row.domain, verified: true, method: 'txt' });
  }));

  // Retry Cloudflare record creation for a tunnel domain whose first attempt
  // failed (expired token, zone not visible yet, transient API error, …).
  api.post(servicePaths('/:id/domains/:domainId/dns'), auth, guard(async (req, res) => {
    const ctx = await requireServiceWriter(req, res);
    if (!ctx) return;
    if (!requireHttp(ctx, res)) return;
    if (!req.auth.user.admin) {
      res.status(403).json({ message: 'Only an instance admin can use DNS automation; publish the TXT challenge instead' });
      return;
    }
    const { rows } = await pool.query(
      'SELECT id, kind, domain, verified, verify_token, cf_zone_id, cf_record_id FROM deploy_domains WHERE id = $1 AND service_id = $2',
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
    const reservedReason = reservedDomainReason(row.domain, {
      baseDomain: process.env.DEPLOY_BASE_DOMAIN || '', reserved: reservedDomainSet(),
    });
    if (reservedReason) { res.status(409).json({ message: reservedReason }); return; }
    const dns = await provisionDns(row, row.domain, req.auth.user);
    const verified = row.verified === true || dns.status === 'created';
    await proxyInvalidate();
    res.json({ id: Number(row.id), domain: row.domain, verified,
      verification: verificationStatus({ ...row, verified }), dns, guidance: domainGuidance(row.domain, row.kind) });
  }));

  api.delete(servicePaths('/:id/domains/:domainId'), auth, guard(async (req, res) => {
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
  // Space visibility alone never grants access to private service activity.
  // -------------------------------------------------------------------------

  api.get('/spaces/:space/deployments', auth, guard(async (req, res) => {
    const user = req.auth.user;
    const space = await loadSpace(req, res);
    if (!space) return;
    const services = await visibleServices(user, space.uid);

    const domainsByService = new Map();
    const tlsRiskByService = new Map();
    // Domains that are attached but not yet proven — they are NOT routed, so
    // the board must say so instead of listing a hostname that serves nothing.
    const unverifiedByService = new Map();
    if (services.length) {
      const ids = services.map(s => s.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const { rows: domainRows } = await pool.query(
        `SELECT service_id, domain, tls_risk, verified FROM deploy_domains WHERE service_id IN (${placeholders}) ORDER BY created`,
        ids,
      );
      for (const d of domainRows) {
        if (services.find(s => Number(s.id) === Number(d.service_id))?.exposure === 'internal') continue;
        const list = domainsByService.get(Number(d.service_id)) || [];
        list.push(d.domain);
        domainsByService.set(Number(d.service_id), list);
        if (d.tls_risk) {
          const risky = tlsRiskByService.get(Number(d.service_id)) || [];
          risky.push(d.domain);
          tlsRiskByService.set(Number(d.service_id), risky);
        }
        if (d.verified === false) {
          const parked = unverifiedByService.get(Number(d.service_id)) || [];
          parked.push(d.domain);
          unverifiedByService.set(Number(d.service_id), parked);
        }
      }
    }

    const out = [];
    for (const s of services) {
      const summary = await currentDeploymentSummary(s);
      out.push(rowToService(s, {
        current: summary,
        can_write: s.can_write,
        repo_uid: s.repo_uid,
        alert: s.last_failed_deployment_id != null,
        domains: domainsByService.get(Number(s.id)) || [],
        tls_risk_domains: tlsRiskByService.get(Number(s.id)) || [],
        unverified_domains: unverifiedByService.get(Number(s.id)) || [],
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

    const flags = runtimeFlagsFromEnv(env);
    res.json({ services: out, activity, can_write: await canWrite(space.uid, user), capabilities: {
      host_mounts: Boolean(user.admin && flags.bindAllowlist.length),
      bind_allowlist: user.admin ? flags.bindAllowlist : [],
      gpus: Boolean(user.admin),
      git_hosts: externalGitHosts(env),
    } });
  }));

  // -------------------------------------------------------------------------
  // Dashboard overview — most active deployments across visible spaces.
  // -------------------------------------------------------------------------

  api.get('/deployments/overview', auth, guard(async (req, res) => {
    const user = req.auth.user;
    const services = await visibleServices(user);

    const ids = services.map(s => s.id);
    const reqCounts = new Map();
    // Attached-but-unproven domains are not routed, so the overview flags them
    // rather than showing a hostname that serves nothing.
    const unverifiedByService = new Map();
    if (ids.length) {
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
      const [{ rows }, { rows: domainRows }] = await Promise.all([
        pool.query(
          `SELECT service_id, COUNT(*)::int AS n FROM deploy_http_logs
           WHERE service_id IN (${placeholders}) AND ts > $${ids.length + 1}
           GROUP BY service_id`,
          [...ids, Date.now() - 24 * 3600_000],
        ),
        pool.query(
          `SELECT service_id, domain FROM deploy_domains
           WHERE service_id IN (${placeholders}) AND verified = FALSE`,
          ids,
        ),
      ]);
      for (const r of rows) reqCounts.set(Number(r.service_id), Number(r.n));
      for (const d of domainRows) {
        if (services.find(s => Number(s.id) === Number(d.service_id))?.exposure === 'internal') continue;
        const list = unverifiedByService.get(Number(d.service_id)) || [];
        list.push(d.domain);
        unverifiedByService.set(Number(d.service_id), list);
      }
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
          can_write: s.can_write,
          requests_24h: reqCounts.get(Number(s.id)) || 0,
          alert: failed,
          live,
          unverified_domains: unverifiedByService.get(Number(s.id)) || [],
        }),
        space: s.space_uid,
        repo_uid: s.repo_uid,
      });
    }
    out.sort((a, b) => b.requests_24h - a.requests_24h);
    res.json(out.slice(0, 20));
  }));

  return api;
}

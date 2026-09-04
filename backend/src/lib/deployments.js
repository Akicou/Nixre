// Deployment lifecycle orchestration.
//
// One engine instance owns the state machine taking a git commit to a healthy,
// traffic-serving container: resolve ref -> git-archive tarball -> docker build
// -> labeled container (env, CPU/RAM caps, unless-stopped restart policy,
// core network) -> health probe -> blue/green swap. A failed build/release
// NEVER touches the currently serving container — fallback is structural —
// and the failure lands on last_failed_deployment_id so the UI can warn hard.
//
// Everything impure arrives via `drivers`; production bindings live in
// deployDrivers.js. Pool access is dependency-injected for hermetic tests.

import {
  normalizeRootDir,
  archiveSpec,
  makeImageTag,
  containerName,
  computeUsage,
} from './deployPure.js';
import { decryptSecret } from './ai.js';
import { getRuntimeOptions } from './deployRuntimeOptions.js';
import * as bus from './deployBus.js';

const SERVICE_TABLE = 'deploy_services';
const DEP_TABLE = 'deployments';

class Cancelled extends Error {
  constructor() {
    super('Deploy cancelled');
    this.cancelled = true;
  }
}

export function createDeploymentEngine({
  pool,
  drivers,
  decryptValue = decryptSecret,
  healthTimeoutMs = Number(process.env.DEPLOY_HEALTH_TIMEOUT_MS || 30_000),
  drainMs = Number(process.env.DEPLOY_DRAIN_MS || 5_000),
  keepImages = 8,
}) {
  /** @type {Map<number, {deploymentId:number, controller:AbortController, cancelled:boolean, reuseImage?:string}>} */
  const activeRuns = new Map();
  const targetCache = new Map(); // serviceId -> { ts, target }
  const metricRings = new Map(); // serviceId -> [{ts, cpuPctOfLimit, memUsedBytes, memPctOfLimit}]

  const now = () => drivers.now?.() ?? Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isBusy(serviceId) {
    return activeRuns.has(serviceId);
  }
  async function waitIdle(serviceId) {
    while (activeRuns.has(serviceId)) await sleep(2);
  }
  async function waitAllIdle() {
    while (activeRuns.size > 0) await sleep(2);
  }

  // --- SQL helpers ----------------------------------------------------------
  // Contract shared with the test interpreter: every SET column gets a
  // numbered placeholder left-to-right and the row id comes LAST.

  const getService = async id =>
    (await pool.query(`SELECT * FROM ${SERVICE_TABLE} WHERE id = $1`, [id])).rows[0];

  const getRepoById = async id =>
    (await pool.query('SELECT * FROM repos WHERE id = $1', [id])).rows[0];

  async function updateTable(table, id, cols) {
    // Call sites may wrap values as {v} — unwrap so SQL params are raw values.
    const entries = Object.entries(cols).map(([name, v]) => [
      name,
      v && typeof v === 'object' && 'v' in v ? v.v : v,
    ]);
    const setSql = entries.map(([name], i) => `${name} = $${i + 1}`).join(', ');
    const q = `UPDATE ${table} SET ${setSql} WHERE id = $${entries.length + 1}`;
    await pool.query(q, [...entries.map(([, v]) => v), id]);
  }

  const updateDeployments = (deploymentId, cols) => updateTable(DEP_TABLE, deploymentId, cols);
  const updateServices = (serviceId, cols) => updateTable(SERVICE_TABLE, serviceId, cols);

  async function requireDocker() {
    const docker = await drivers.getDocker().catch(() => null);
    if (!docker) {
      throw Object.assign(new Error('Docker is not available on this host'), { status: 503 });
    }
    return docker;
  }

  async function getNetwork(docker) {
    try {
      return (await drivers.networkName(docker)) || '';
    } catch {
      return '';
    }
  }

  // --- public API -----------------------------------------------------------

  /**
   * Kick off a deployment. Resolves right after the run registers (the build
   * continues in the background); errors shaped {status} surface sync-style.
   */
  async function startDeployment(
    serviceId,
    { ref, trigger = 'manual', _reuseImage } = {},
  ) {
    if (activeRuns.has(serviceId)) {
      throw Object.assign(new Error('A deployment is already running for this service'), {
        status: 409,
      });
    }
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    if (service.desired_state === 'stopped' && trigger !== 'manual') {
      return { deploymentId: null, skipped: 'desired_state stopped' };
    }

    const controller = new AbortController();
    const entry = { deploymentId: 0, controller, cancelled: false, reuseImage: _reuseImage };
    activeRuns.set(serviceId, entry);

    const dep = (
      await pool.query(
        `INSERT INTO ${DEP_TABLE}
           (service_id, ref, trigger_kind, status, started)
         VALUES ($1, $2, $3, 'queued', $4) RETURNING *`,
        [serviceId, String(ref || service.branch || ''), trigger, now()],
      )
    ).rows[0];
    entry.deploymentId = dep.id;

    await updateServices(serviceId, { status: { v: 'deploying' }, updated: { v: now() } });
    bus.publishStatus(serviceId, 'queued', { deploymentId: dep.id, trigger });

    void runPipeline(service, dep, entry).catch(err => {
      console.error(`deploy svc#${serviceId} crashed unexpectedly:`, err.message);
    });

    return { deploymentId: dep.id, deployment: dep };
  }

  async function cancelDeployment(serviceId) {
    const entry = activeRuns.get(serviceId);
    if (!entry) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
  }

  /** Rollback: re-release a historical deployment's image without rebuilding. */
  async function rollback(serviceId, sourceDeploymentId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    if (sourceDeploymentId === service.current_deployment_id) {
      throw Object.assign(new Error('That deployment is already being served'), { status: 400 });
    }
    if (activeRuns.has(serviceId)) {
      throw Object.assign(new Error('A deployment is already running'), { status: 409 });
    }
    const src = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [sourceDeploymentId]))
      .rows[0];
    if (!src || src.service_id !== serviceId) {
      throw Object.assign(new Error('No such deployment'), { status: 404 });
    }
    if (!src.image_tag) {
      throw Object.assign(new Error('That deployment has no built image to roll back to'), {
        status: 400,
      });
    }

    const { deployment } = await startDeployment(serviceId, {
      ref: src.sha || src.ref,
      trigger: 'rollback',
      _reuseImage: src.image_tag,
    });
    return deployment;
  }

  /** Re-run a past deployment's exact ref/config as a fresh release. */
  async function redeploy(serviceId, deploymentId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    let dep = null;
    if (deploymentId != null) {
      dep = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [deploymentId])).rows[0];
      if (!dep || dep.service_id !== serviceId) {
        throw Object.assign(new Error('No such deployment'), { status: 404 });
      }
    } else if (service.current_deployment_id) {
      dep = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [
        service.current_deployment_id,
      ])).rows[0];
    }
    return startDeployment(serviceId, {
      ref: dep?.sha || dep?.ref || service.branch,
      trigger: 'redeploy',
    });
  }

  async function deleteDeployment(serviceId, deploymentId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    if (service.current_deployment_id === deploymentId) {
      throw Object.assign(
        new Error(
          'This deployment is serving traffic — deploy something newer or stop the service before deleting it',
        ),
        { status: 400 },
      );
    }
    await removeContainerIfExists(serviceId, containerName(serviceId, deploymentId));
    try {
      const docker = await requireDocker();
      await docker.getImage(makeImageTag(serviceId, deploymentId)).remove({ force: true });
    } catch {
      /* docker down or image already gone */
    }
    await pool.query(`DELETE FROM ${DEP_TABLE} WHERE id = $1`, [deploymentId]);
  }

  async function stopService(serviceId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    await updateServices(serviceId, {
      desired_state: { v: 'stopped' },
      status: { v: 'stopped' },
      updated: { v: now() },
    });
    targetCache.delete(serviceId);
    if (service.current_deployment_id) {
      await retireOldContainer(serviceId, service.current_deployment_id);
    }
  }

  async function startService(serviceId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    await updateServices(serviceId, {
      desired_state: { v: 'running' },
      updated: { v: now() },
    });
    targetCache.delete(serviceId);
    await sweepService(service);
    return { started: Boolean(service.current_deployment_id) };
  }

  // --- pipeline -------------------------------------------------------------

  async function runPipeline(service, dep, entry) {
    const { deploymentId } = entry;
    const startedAt = dep.started;
    try {
      const serviceFresh = (await getService(service.id)) || service;
      const repo = await getRepoById(serviceFresh.repo_id);
      if (!repo) throw new Error('Repository for this service no longer exists');

      const docker = await requireDocker();
      let imageTag;

      if (entry.reuseImage) {
        // Rollback path — no ref resolution, no build.
        imageTag = entry.reuseImage;
        await updateDeployments(deploymentId, {
          sha: { v: dep.ref },
          status: { v: 'releasing' },
          image_tag: { v: imageTag },
        });
        bus.publishStatus(serviceFresh.id, 'releasing', { deploymentId });
        bus.publishLog(serviceFresh.id, 'release', `Releasing stored image ${imageTag}…`);
      } else {
        const ref = dep.ref || serviceFresh.branch || '';
        bus.publishLog(serviceFresh.id, 'release', `Resolving ${ref}…`);
        const { sha, message } = await drivers.resolveRef(repo.space_uid, repo.uid, ref);
        throwIfCancelled(entry);

        imageTag = makeImageTag(serviceFresh.id, deploymentId);
        await updateDeployments(deploymentId, {
          sha: { v: sha },
          message: { v: String(message || '').slice(0, 300) },
          status: { v: 'building' },
          image_tag: { v: imageTag },
        });
        bus.publishStatus(serviceFresh.id, 'building', { deploymentId });

        await buildImage({ docker, service: serviceFresh, repo, sha, imageTag, entry });
        throwIfCancelled(entry);
        await updateDeployments(deploymentId, { status: { v: 'releasing' } });
        bus.publishStatus(serviceFresh.id, 'releasing', { deploymentId });
      }

      const envRows = (
        await pool.query(
          `SELECT key, value_enc FROM service_env_vars WHERE service_id = $1 ORDER BY key`,
          [serviceFresh.id],
        )
      ).rows;
      const env = envRows.map(r => `${r.key}=${decryptValue(r.value_enc)}`);

      const info = await launchContainer({
        docker,
        service: serviceFresh,
        repo,
        deploymentId,
        imageTag,
        env,
      });
      bus.publishLog(
        serviceFresh.id,
        'release',
        `Waiting for the app to answer on :${serviceFresh.container_port}…`,
      );
      await waitForHealth({ docker, service: serviceFresh, info, entry });

      // ---- swap ----
      const previousId = serviceFresh.current_deployment_id;
      await updateDeployments(deploymentId, {
        status: { v: 'live' },
        finished: { v: now() },
        duration_ms: { v: Math.max(0, now() - startedAt) },
      });
      await updateServices(serviceFresh.id, {
        current_deployment_id: { v: deploymentId },
        status: { v: 'running' },
        last_failed_deployment_id: { v: null },
        updated: { v: now() },
      });
      targetCache.delete(serviceFresh.id);
      bus.publishStatus(serviceFresh.id, 'live', { deploymentId, previousId });
      bus.publishLog(
        serviceFresh.id,
        'release',
        `Live${dep.sha ? `, serving ${(dep.sha || '').slice(0, 7)}` : ''}.`,
      );

      if (previousId && previousId !== deploymentId) {
        void retireOldContainer(serviceFresh.id, previousId)
          .catch(() => {})
          .finally(() => {});
      }
      void pruneServiceImages(docker, serviceFresh.id, deploymentId).catch(() => {});
    } catch (err) {
      await settleFailure(service, dep, entry, err);
    } finally {
      if (activeRuns.get(service.id) === entry) activeRuns.delete(service.id);
    }
  }

  async function settleFailure(service, dep, entry, err) {
    const cancelled = err instanceof Cancelled || entry.controller.signal.aborted;
    try {
      const message = cancelled
        ? 'Cancelled by user'
        : String(err?.message || 'deploy failed').slice(0, 800);
      await updateDeployments(entry.deploymentId, {
        status: { v: cancelled ? 'cancelled' : 'failed' },
        ...(cancelled ? {} : { error: { v: message } }),
        finished: { v: now() },
        duration_ms: { v: Math.max(0, now() - dep.started) },
      });
      const wasServing = Boolean(service.current_deployment_id);
      await updateServices(service.id, {
        status: { v: wasServing ? 'running' : cancelled ? 'idle' : 'failed' },
        ...(cancelled ? {} : { last_failed_deployment_id: { v: entry.deploymentId } }),
        updated: { v: now() },
      });
      bus.publishStatus(service.id, cancelled ? 'cancelled' : 'failed', {
        deploymentId: entry.deploymentId,
        error: cancelled ? undefined : message,
        servingPrevious: wasServing,
      });
      targetCache.delete(service.id);
      await removeContainerIfExists(service.id, containerName(service.id, entry.deploymentId));
    } catch (err2) {
      console.error('failure handling error:', err2.message);
    }
  }

  function throwIfCancelled(entry) {
    if (entry.cancelled || entry.controller.signal.aborted) throw new Cancelled();
  }

  async function buildImage({ docker, service, repo, sha, imageTag, entry }) {
    const rootDir = normalizeRootDir(service.root_dir);
    const spec = archiveSpec(sha, rootDir);

    let tarStream;
    try {
      tarStream = await drivers.archiveTar(
        repo.space_uid,
        repo.uid,
        spec,
        entry.controller.signal,
      );
    } catch (err) {
      if (entry.controller.signal.aborted) throw new Cancelled();
      throw err;
    }

    const aborted = new Promise((_, reject) => {
      entry.controller.signal.addEventListener('abort', () => reject(new Cancelled()), {
        once: true,
      });
    });

    let logText = '';
    const res = await Promise.race([aborted, docker.buildImage(tarStream, { t: imageTag })]);

    await new Promise((resolve, reject) => {
      let buf = '';
      res.on('data', chunk => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const raw = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!raw) continue;
          let evt;
          try {
            evt = JSON.parse(raw);
          } catch {
            evt = { stream: raw };
          }
          const text =
            evt.stream ?? evt.errorDetail?.message ?? evt.error ?? '';
          if (text) {
            logText += text.endsWith('\n') || text.endsWith('\r') ? text : `${text}\n`;
            bus.publishLog(service.id, 'build', String(text).trimEnd().slice(0, 300));
          }
          if (evt.error) {
            reject(new Error(evt.error));
            return;
          }
        }
      });
      res.on('end', resolve);
      res.on('error', reject);
    }).catch(err => {
      if (err instanceof Cancelled || entry.controller.signal.aborted) throw new Cancelled();
      throw err;
    });

    try {
      await Promise.race([aborted, saveBuildLog(service.id, entry.deploymentId, logText)]);
    } catch (err) {
      if (entry.controller.signal.aborted) throw new Cancelled();
      /* log persistence failures must not fail an otherwise-good build */
    }
  }

  async function saveBuildLog(serviceId, deploymentId, logText) {
    await updateDeployments(deploymentId, {
      build_log: { v: logText.slice(-900_000) },
    });
    void serviceId;
  }

  async function launchContainer({ docker, service, repo, deploymentId, imageTag, env }) {
    const name = containerName(service.id, deploymentId);
    // A stale shell of the same name (crashed prior attempt) blocks creation.
    try {
      await docker.getContainer(name).inspect();
      await docker.getContainer(name).remove({ force: true });
    } catch {
      /* no leftover under this name */
    }
    const net = await getNetwork(docker);
    const ro = getRuntimeOptions(service);
    const hc = ro?.host_config || null;

    const hostConfig = {
      Memory: Number(service.memory_bytes),
      NanoCpus: Number(service.cpu_nano_cpus),
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
    };
    if (hc) {
      // Values here were validated by normalizeRuntimeOptions at API time;
      // getRuntimeOptions is the defensive re-read. An explicit network_mode
      // (host/none/container:*) replaces the default core-network attachment.
      if (hc.binds.length) hostConfig.Binds = hc.binds;
      if (hc.privileged) hostConfig.Privileged = true;
      if (hc.cap_add.length) hostConfig.CapAdd = hc.cap_add;
      if (hc.cap_drop.length) hostConfig.CapDrop = hc.cap_drop;
      if (hc.devices.length) hostConfig.Devices = hc.devices;
      if (hc.group_add.length) hostConfig.GroupAdd = hc.group_add;
      if (hc.extra_hosts.length) hostConfig.ExtraHosts = hc.extra_hosts;
      if (hc.shm_size != null) hostConfig.ShmSize = hc.shm_size;
      if (Object.keys(hc.tmpfs).length) hostConfig.Tmpfs = hc.tmpfs;
      if (hc.network_mode) hostConfig.NetworkMode = hc.network_mode;
    }

    const createOpts = {
      name,
      Image: imageTag,
      Labels: {
        'nixre.deploy': 'true',
        'nixre.service': String(service.id),
        'nixre.deployment': String(deploymentId),
        'nixre.repo': `${repo.space_uid}/${repo.uid}`,
        'nixre.name': service.name,
      },
      Env: env,
      HostConfig: hostConfig,
    };
    if (ro?.command) createOpts.Cmd = ro.command;
    if (ro?.entrypoint) createOpts.Entrypoint = ro.entrypoint;
    // Explicit network modes conflict with EndpointsConfig — omit ours then.
    if (net && !(hc && hc.network_mode)) {
      createOpts.NetworkingConfig = { EndpointsConfig: { [net]: {} } };
    }
    const created = await docker.createContainer(createOpts);
    await created.start();
    return created.inspect();
  }

  async function waitForHealth({ docker, service, info, entry }) {
    const net = await getNetwork(docker);
    const networks = info.NetworkSettings?.Networks || {};
    const ip =
      networks[net]?.IPAddress ||
      Object.values(networks).map(n => n.IPAddress).find(Boolean);
    if (!ip) throw new Error('Container has no routable IP yet');

    const ro = getRuntimeOptions(service);
    const probePath = ro?.health_path || '/';
    const budgetMs = ro?.health_timeout_ms || healthTimeoutMs;
    const deadline = Date.now() + budgetMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      throwIfCancelled(entry);
      try {
        const prober = await drivers.probeHttp();
        const out = await prober({
          host: ip,
          port: service.container_port,
          path: probePath,
          timeoutMs: 2500,
          signal: entry.controller.signal,
        });
        if (out.ok || out.status) {
          bus.publishLog(
            service.id,
            'release',
            `Health probe answered HTTP ${out.status ?? 'OK'} — releasing.`,
          );
          return { ip };
        }
        lastErr = out.status ? `HTTP ${out.status}` : 'no response';
      } catch (err) {
        if (entry.controller.signal.aborted) throw new Cancelled();
        lastErr = err.message;
      }
      await sleep(20);
    }
    throw new Error(
      `Health check failed: app did not answer on port ${service.container_port} ` +
        `${probePath} within ${Math.round(budgetMs / 1000)}s (${lastErr})`,
    );
  }

  async function retireOldContainer(serviceId, oldDeploymentId) {
    targetCache.delete(serviceId);
    await sleep(drainMs); // let in-flight proxy requests drain first
    try {
      const docker = await requireDocker();
      const c = docker.getContainer(containerName(serviceId, oldDeploymentId));
      await c.stop({ t: 10 });
      await c.remove();
    } catch {
      /* old container already gone or docker down */
    }
  }

  async function removeContainerIfExists(serviceId, name) {
    targetCache.delete(serviceId);
    try {
      const docker = await requireDocker();
      await docker.getContainer(name).remove({ force: true });
    } catch {
      /* never existed or docker down */
    }
  }

  async function pruneServiceImages(docker, serviceId, currentDeploymentId) {
    let listed = [];
    try {
      listed = await docker.listImages();
    } catch {
      return;
    }
    const prefix = `nixre-app-svc${serviceId}-dep`;
    const ours = [];
    for (const img of listed) {
      for (const tag of img.RepoTags || []) {
        const m = tag.match(new RegExp(`^${prefix}(\\d+):`));
        if (m) ours.push({ tag, dep: Number(m[1]) });
      }
    }
    ours.sort((a, b) => b.dep - a.dep);
    for (const item of ours.slice(keepImages)) {
      if (item.dep === currentDeploymentId) continue;
      try {
        await docker.getImage(item.tag).remove({ force: true });
      } catch {
        /* in use or gone */
      }
    }
  }

  // --- sweep ------------------------------------------------------------------

  async function sweep(clockNow) {
    const ts = clockNow ?? now();

    // 1) Runs that were mid-flight when a previous core process died.
    const ownedIds = new Set([...activeRuns.values()].map(e => e.deploymentId));
    const { rows: stuck } = await pool.query(
      `SELECT * FROM ${DEP_TABLE} WHERE status IN ('queued','building','releasing')`,
    );
    for (const row of stuck) {
      if (ownedIds.has(row.id)) continue;
      await pool.query(
        `UPDATE ${DEP_TABLE} SET status = $1, error = $2, finished = $3, duration_ms = $4 WHERE id = $5`,
        ['failed', 'Interrupted by restart', ts, Math.max(0, ts - row.started), row.id],
      );
    }

    let docker = null;
    try {
      docker = await drivers.getDocker();
    } catch {
      docker = null;
    }

    const { rows: services } = await pool.query(`SELECT * FROM ${SERVICE_TABLE}`);
    for (const service of services) {
      if (activeRuns.has(service.id)) continue;
      if (docker) await sweepService(service, { docker, ts });

      // Preserve-failures retention: successes age out fast, >= threshold slow.
      const successCutoff = ts - service.success_retention_hours * 3600_000;
      const failureCutoff = ts - service.failure_retention_hours * 3600_000;
      await pool.query(
        `DELETE FROM deploy_http_logs WHERE service_id = $1 AND ts < $2 AND status_code < $3`,
        [service.id, successCutoff, service.preserve_status_min],
      );
      await pool.query(
        `DELETE FROM deploy_http_logs WHERE service_id = $1 AND ts < $2 AND (status_code >= $3 OR status_code IS NULL)`,
        [service.id, failureCutoff, service.preserve_status_min],
      );
      await pool.query(`DELETE FROM deploy_uptime_checks WHERE service_id = $1 AND ts < $2`, [
        service.id,
        ts - 30 * 24 * 3600_000,
      ]);
    }
    return { sweptAt: ts, services: services.length };
  }

  async function sweepService(service, ctx = {}) {
    const docker = ctx.docker || (await drivers.getDocker().catch(() => null));
    if (!docker) return;
    const ts = ctx.ts ?? now();

    if (service.desired_state === 'stopped') {
      if (service.current_deployment_id) {
        await stopContainerQuiet(
          docker,
          containerName(service.id, service.current_deployment_id),
        );
      }
      if (service.status !== 'stopped') {
        await updateServices(service.id, { status: { v: 'stopped' }, updated: { v: ts } });
      }
      return;
    }

    if (!service.current_deployment_id) {
      if (['running'].includes(service.status)) {
        await updateServices(service.id, { status: { v: 'idle' }, updated: { v: ts } });
      }
      return;
    }

    const dep = (
      await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [service.current_deployment_id])
    ).rows[0];
    if (!dep) {
      await updateServices(service.id, { status: { v: 'idle' }, updated: { v: ts } });
      return;
    }

    const name = containerName(service.id, dep.id);
    let info = null;
    try {
      info = await docker.getContainer(name).inspect();
    } catch {
      info = null;
    }

    if (!info && dep.image_tag) {
      // Host rebooted / container pruned: recreate silently from the stored
      // image. Never rebuild during boot — autostart must be cheap.
      try {
        const repo = await getRepoById(service.repo_id);
        const envRows = (
          await pool.query(
            `SELECT key, value_enc FROM service_env_vars WHERE service_id = $1 ORDER BY key`,
            [service.id],
          )
        ).rows;
        const env = envRows.map(r => `${r.key}=${decryptValue(r.value_enc)}`);
        await launchContainer({
          docker,
          service,
          repo,
          deploymentId: dep.id,
          imageTag: dep.image_tag,
          env,
        });
        bus.publishStatus(service.id, 'running', { deploymentId: dep.id, rebooted: true });
        bus.publishLog(
          service.id,
          'release',
          `Boot autostart: container recreated from stored image (${String(dep.sha).slice(0, 7)}).`,
        );
        await updateServices(service.id, { status: { v: 'running' }, updated: { v: ts } });
        targetCache.delete(service.id);
      } catch (err) {
        console.error(`boot recreate failed for svc#${service.id}:`, err.message);
        await updateServices(service.id, { status: { v: 'failed' }, updated: { v: ts } });
      }
      return;
    }

    if (!info) {
      await updateServices(service.id, { status: { v: 'idle' }, updated: { v: ts } });
      return;
    }

    if (info.State?.Status !== 'running') {
      try {
        await docker.getContainer(name).start();
      } catch {
        /* docker may be restarting it concurrently */
      }
    }
    const upNow = await safeRunning(docker, name);
    await updateServices(service.id, {
      status: { v: upNow ? 'running' : 'stopped' },
      updated: { v: ts },
    });
    targetCache.delete(service.id);
  }

  async function stopContainerQuiet(docker, name) {
    try {
      await docker.getContainer(name).stop({ t: 10 });
      await docker.getContainer(name).remove();
    } catch {
      /* already gone */
    }
  }

  async function safeRunning(docker, name) {
    try {
      const info = await docker.getContainer(name).inspect();
      return info.State?.Status === 'running';
    } catch {
      return false;
    }
  }

  // --- push automation ---------------------------------------------------------

  async function maybeAutoDeploy({ space, repo, branch, after }) {
    const { rows: candidates } = await pool.query(
      `SELECT s.* FROM deploy_services s JOIN repos r ON r.id = s.repo_id
       WHERE r.space_uid = $1 AND r.uid = $2`,
      [space, repo],
    );
    let kicked = 0;
    for (const svc of candidates) {
      if (!svc.auto_deploy) continue;
      if (svc.branch !== branch) continue;
      if (svc.desired_state !== 'running') continue;
      if (activeRuns.has(svc.id)) continue;
      try {
        await startDeployment(svc.id, { ref: after || branch, trigger: 'push' });
        kicked++;
      } catch (err) {
        if (err.status !== 409) console.error(`auto-deploy svc#${svc.id}:`, err.message);
      }
    }
    return kicked;
  }

  // --- probes & metrics ----------------------------------------------------------

  async function serviceTarget(service, docker) {
    const cached = targetCache.get(service.id);
    if (cached && now() - cached.ts < 2000) return cached.target;
    let target = null;
    if (service.current_deployment_id && docker) {
      try {
        const name = containerName(service.id, service.current_deployment_id);
        const info = await docker.getContainer(name).inspect();
        if (info.State?.Status === 'running') {
          const net = await getNetwork(docker);
          const networks = info.NetworkSettings?.Networks || {};
          const ip =
            networks[net]?.IPAddress ||
            Object.values(networks).map(n => n.IPAddress).find(Boolean);
          if (ip) {
            target = {
              ip,
              port: service.container_port,
              deploymentId: service.current_deployment_id,
            };
          }
        }
      } catch {
        target = null;
      }
    }
    targetCache.set(service.id, { ts: now(), target });
    return target;
  }

  async function probeTick() {
    const docker = await drivers.getDocker().catch(() => null);
    if (!docker) return [];
    const { rows: services } = await pool.query(`SELECT * FROM ${SERVICE_TABLE}`);
    const results = [];
    for (const service of services) {
      if (service.desired_state !== 'running' || !service.current_deployment_id) continue;
      const target = await serviceTarget(service, docker);
      const t0 = Date.now();
      let outcome = { ok: false, status: null };
      if (target) {
        try {
          const prober = await drivers.probeHttp();
          outcome = await prober({
            host: target.ip,
            port: target.port,
            path: getRuntimeOptions(service)?.health_path || '/',
            timeoutMs: 3000,
          });
          if (outcome && typeof outcome === 'object' && !('ok' in outcome)) {
            outcome = { ok: Boolean(outcome.status), status: outcome.status };
          }
        } catch {
          outcome = { ok: false, status: null };
        }
      }
      results.push({ serviceId: service.id, ...outcome });
      await pool.query(
        `INSERT INTO deploy_uptime_checks (service_id, ok, latency_ms, status_code, ts)
         VALUES ($1, $2, $3, $4, $5)`,
        [service.id, Boolean(outcome.ok), Date.now() - t0, outcome.status ?? null, Date.now()],
      );
      bus.publish(service.id, {
        type: 'uptime',
        ok: Boolean(outcome.ok),
        status: outcome.status ?? null,
      });
    }
    return results;
  }

  const MAX_METRIC_POINTS = Number(process.env.DEPLOY_METRIC_POINTS || 720);

  async function metricsTick() {
    const docker = await drivers.getDocker().catch(() => null);
    if (!docker) return;
    const { rows: services } = await pool.query(`SELECT * FROM ${SERVICE_TABLE}`);
    for (const service of services) {
      if (service.desired_state !== 'running' || !service.current_deployment_id) continue;
      try {
        const name = containerName(service.id, service.current_deployment_id);
        const raw = await docker.getContainer(name).stats({ stream: false });
        const usage = computeUsage(raw, {
          cpuNanoCpus: service.cpu_nano_cpus,
          memoryBytes: service.memory_bytes,
        });
        const ring = metricRings.get(service.id) || [];
        ring.push({ ts: Date.now(), ...usage });
        if (ring.length > MAX_METRIC_POINTS) ring.splice(0, ring.length - MAX_METRIC_POINTS);
        metricRings.set(service.id, ring);
        bus.publishMetrics(service.id, usage);
      } catch {
        /* container gone or stats unavailable this tick */
      }
    }
  }

  function getStatsSnapshot(serviceId) {
    const ring = metricRings.get(serviceId) || [];
    return { latest: ring.at(-1) || null, series: ring.slice(-120) };
  }

  // For the central proxy: route resolution target for one service.
  async function findServiceTarget(serviceId) {
    const service = await getService(serviceId);
    if (!service) return null;
    const docker = await drivers.getDocker().catch(() => null);
    if (!docker) return null;
    return serviceTarget(service, docker);
  }

  return {
    startDeployment,
    cancelDeployment,
    rollback,
    redeploy,
    deleteDeployment,
    stopService,
    startService,
    maybeAutoDeploy,
    sweep,
    probeTick,
    metricsTick,
    getStatsSnapshot,
    findServiceTarget,
    isBusy,
    waitIdle,
    waitAllIdle,
    invalidateTarget: serviceId => targetCache.delete(serviceId),
  };
}

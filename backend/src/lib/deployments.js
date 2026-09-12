// Deployment lifecycle orchestration.
//
// One engine instance owns the state machine taking a git commit to a healthy,
// traffic-serving container: resolve ref -> git-archive tarball -> docker build
// -> labeled container (env, CPU/RAM caps, unless-stopped restart policy,
// apps network) -> health probe -> blue/green or recreate cutover. Recreate
// persists stopped intent before touching storage and never falls back after
// cutover: the candidate may have mutated a retained volume.
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
import { Readable, Transform, Writable } from 'node:stream';

const SERVICE_TABLE = 'deploy_services';
const DEP_TABLE = 'deployments';
// KILL lets root Tini forward shutdown signals after gosu switches to postgres.
const POSTGRES_CAPS = ['CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SETUID', 'SETGID', 'KILL'];
const POSTGRES_HEALTH = ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'];

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
  buildTimeoutMs = 30 * 60_000,
}) {
  // pg returns BIGINT IDs as strings; routes may pass numbers. Keep all map
  // keys and ID comparisons in string form without losing BIGINT precision.
  /** @type {Map<string, {deploymentId:number|string, controller:AbortController, cancelled:boolean, reuseImage?:string}>} */
  const activeRuns = new Map();
  const maintenance = new Set();
  const targetCache = new Map(); // serviceId -> { ts, target }
  const metricRings = new Map(); // serviceId -> [{ts, cpuPctOfLimit, memUsedBytes, memPctOfLimit}]

  const now = () => drivers.now?.() ?? Date.now();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function isBusy(serviceId) {
    return activeRuns.has(String(serviceId)) || maintenance.has(String(serviceId));
  }
  async function waitIdle(serviceId) {
    while (isBusy(serviceId)) await sleep(2);
  }
  async function waitAllIdle() {
    while (activeRuns.size > 0 || maintenance.size > 0) await sleep(2);
  }

  async function maintain(serviceId, work, { cancel = false } = {}) {
    if (maintenance.has(String(serviceId)) || (!cancel && activeRuns.has(String(serviceId)))) {
      throw Object.assign(new Error('Service lifecycle operation already running'), { status: 409 });
    }
    // Reserve synchronously, before any SQL or Docker await can admit a deploy.
    maintenance.add(String(serviceId));
    try {
      if (cancel) {
        await cancelDeployment(serviceId);
        while (activeRuns.has(String(serviceId))) await sleep(2);
      }
      return await work();
    } finally {
      maintenance.delete(String(serviceId));
    }
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
    const network = await drivers.networkName(docker);
    if (!network) throw new Error('No approved deployment network configured');
    return network;
  }

  // --- public API -----------------------------------------------------------

  /**
   * Kick off a deployment. Resolves right after the run registers (the build
   * continues in the background); errors shaped {status} surface sync-style.
   */
  async function startDeployment(
    serviceId,
    { ref, trigger = 'manual', _reuseImage, _sourceSnapshot } = {},
  ) {
    if (isBusy(serviceId)) {
      throw Object.assign(new Error('A deployment is already running for this service'), {
        status: 409,
      });
    }
    const controller = new AbortController();
    const entry = { deploymentId: 0, controller, cancelled: false, reuseImage: _reuseImage,
      sourceSnapshot: _sourceSnapshot };
    activeRuns.set(String(serviceId), entry);
    try {
      const service = await getService(serviceId);
      if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
      if (service.desired_state === 'stopped' && !['manual', 'redeploy', 'rollback'].includes(trigger)) {
        activeRuns.delete(String(serviceId));
        return { deploymentId: null, skipped: 'desired_state stopped' };
      }
      const dep = (
        await pool.query(
          `INSERT INTO ${DEP_TABLE}
             (service_id, ref, trigger_kind, status, started)
           VALUES ($1, $2, $3, 'queued', $4) RETURNING *`,
          [serviceId, String(service.source_type === 'image'
            ? _sourceSnapshot?.image_ref || service.image_ref || ''
            : ref || service.branch || ''), trigger, now()],
        )
      ).rows[0];
      entry.deploymentId = dep.id;

      await updateServices(serviceId, { status: { v: 'deploying' }, updated: { v: now() } });
      bus.publishStatus(service.id, 'queued', { deploymentId: dep.id, trigger });

      void runPipeline(service, dep, entry).catch(err => {
        console.error(`deploy svc#${serviceId} crashed unexpectedly:`, err.message);
      });

      return { deploymentId: dep.id, deployment: dep };
    } catch (err) {
      if (activeRuns.get(String(serviceId)) === entry) activeRuns.delete(String(serviceId));
      throw err;
    }
  }

  async function cancelDeployment(serviceId) {
    const entry = activeRuns.get(String(serviceId));
    if (!entry) return false;
    entry.cancelled = true;
    entry.controller.abort();
    return true;
  }

  /** Rollback: re-release a historical deployment's image without rebuilding. */
  async function rollback(serviceId, sourceDeploymentId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    if (service.volume_path || service.template) {
      throw Object.assign(new Error('Rollback is disabled for stateful/template services'), { status: 400 });
    }
    if (String(sourceDeploymentId) === String(service.current_deployment_id)) {
      throw Object.assign(new Error('That deployment is already being served'), { status: 400 });
    }
    if (isBusy(serviceId)) {
      throw Object.assign(new Error('A deployment is already running'), { status: 409 });
    }
    const src = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [sourceDeploymentId]))
      .rows[0];
    if (!src || String(src.service_id) !== String(serviceId)) {
      throw Object.assign(new Error('No such deployment'), { status: 404 });
    }
    if (src.config_snapshot?.volume_path || src.config_snapshot?.template) {
      throw Object.assign(new Error('Rollback is disabled for stateful/template releases'), { status: 400 });
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
      _sourceSnapshot: src.config_snapshot,
    });
    return deployment;
  }

  /** Re-release the stored image with current runtime settings; legacy failures rebuild. */
  async function redeploy(serviceId, deploymentId) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    let dep = null;
    if (deploymentId != null) {
      dep = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [deploymentId])).rows[0];
      if (!dep || String(dep.service_id) !== String(serviceId)) {
        throw Object.assign(new Error('No such deployment'), { status: 404 });
      }
    } else if (service.current_deployment_id) {
      dep = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [
        service.current_deployment_id,
      ])).rows[0];
    }
    if (dep && String(dep.id) !== String(service.current_deployment_id) &&
        (service.volume_path || service.template || dep.config_snapshot?.volume_path || dep.config_snapshot?.template)) {
      throw Object.assign(new Error('Historical redeploy is disabled for stateful/template services; deploy explicitly to recover'), { status: 400 });
    }
    return startDeployment(serviceId, {
      ref: dep?.sha || dep?.ref || service.branch,
      trigger: 'redeploy',
      _reuseImage: dep?.status === 'live' ? dep.image_tag : undefined,
      _sourceSnapshot: dep?.status === 'live' ? dep.config_snapshot : undefined,
    });
  }

  async function deleteDeployment(serviceId, deploymentId) {
    return maintain(serviceId, async () => {
      const service = await getService(serviceId);
      if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
      const dep = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [deploymentId])).rows[0];
      if (!dep || String(dep.service_id) !== String(serviceId)) {
        throw Object.assign(new Error('No such deployment'), { status: 404 });
      }
      if (String(service.current_deployment_id) === String(deploymentId)) {
        throw Object.assign(new Error('This is the current release; deploy something newer before deleting it'), { status: 400 });
      }
      await removeContainerIfExists(serviceId, containerName(serviceId, deploymentId));
      const tag = makeImageTag(serviceId, deploymentId);
      const shared = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE image_tag = $1 AND id <> $2`,
        [tag, deploymentId])).rows.length > 0;
      try {
        const docker = await requireDocker();
        if (!shared) await docker.getImage(tag).remove();
      } catch {
        /* docker down or image already gone */
      }
      await pool.query(`DELETE FROM ${DEP_TABLE} WHERE id = $1`, [deploymentId]);
    });
  }

  async function stopService(serviceId) {
    return maintain(serviceId, async () => {
      const service = await getService(serviceId);
      if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
      await updateServices(serviceId, {
        desired_state: { v: 'stopped' },
        status: { v: 'stopped' },
        updated: { v: now() },
      });
      targetCache.delete(String(serviceId));
      await quiesceService(await requireDocker(), service);
    }, { cancel: true });
  }

  async function startService(serviceId) {
    return maintain(serviceId, async () => {
      const service = await getService(serviceId);
      if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
      if (!service.current_deployment_id && service.desired_state === 'stopped') {
        throw Object.assign(new Error('No safe current release; deploy explicitly to recover'), { status: 409 });
      }
      await updateServices(serviceId, {
        desired_state: { v: 'running' },
        updated: { v: now() },
      });
      targetCache.delete(String(serviceId));
      await sweepService({ ...service, desired_state: 'running' });
      return { started: Boolean(service.current_deployment_id) };
    });
  }

  // --- pipeline -------------------------------------------------------------

  async function runPipeline(service, dep, entry) {
    const { deploymentId } = entry;
    const startedAt = dep.started;
    let externalSource;
    try {
      const serviceFresh = (await getService(service.id)) || service;
      validateServiceRuntime(serviceFresh);
      throwIfCancelled(entry);
      const sourceType = serviceFresh.source_type || 'repo';
      // Stored images do not depend on a Git server (including deleted repos).
      const repo = sourceType === 'repo' && serviceFresh.repo_id
        ? await getRepoById(serviceFresh.repo_id) : null;
      if (!entry.reuseImage && sourceType === 'repo' && !repo) {
        throw new Error('Repository for this service no longer exists');
      }
      const docker = await requireDocker();
      let imageTag;
      const ro = getRuntimeOptions(serviceFresh);
      const sourceConfig = entry.sourceSnapshot || serviceFresh;
      await updateDeployments(deploymentId, { config_snapshot: {
        source_type: sourceConfig.source_type || 'repo',
        repo_id: sourceConfig.repo_id ?? null,
        git_url: sourceConfig.git_url ?? null,
        image_ref: sourceConfig.image_ref ?? null,
        root_dir: sourceConfig.root_dir ?? '.',
        dockerfile_path: sourceConfig.dockerfile_path ?? 'Dockerfile',
        build_target: sourceConfig.build_target ?? null,
        template: serviceFresh.template ?? null,
        volume_path: serviceFresh.volume_path ?? null,
        exposure: serviceFresh.exposure || 'http',
        deployment_strategy: serviceFresh.deployment_strategy || 'blue_green',
        container_port: serviceFresh.container_port,
        cpu_nano_cpus: serviceFresh.cpu_nano_cpus,
        memory_bytes: serviceFresh.memory_bytes,
        health_type: serviceFresh.template === 'postgres' ? 'docker' : ro?.health_type || 'http',
        health_timeout_ms: ro?.health_timeout_ms ?? null,
      } });

      if (entry.reuseImage) {
        // Rollback path — no ref resolution, no build.
        imageTag = entry.reuseImage;
        await updateDeployments(deploymentId, {
          sha: { v: sourceConfig.source_type === 'image' ? '' : dep.ref },
          status: { v: 'releasing' },
          image_tag: { v: imageTag },
        });
        bus.publishStatus(serviceFresh.id, 'releasing', { deploymentId });
        bus.publishLog(serviceFresh.id, 'release', `Releasing stored image ${imageTag}…`);
      } else {
        const ref = dep.ref || serviceFresh.branch || '';
        bus.publishLog(serviceFresh.id, 'release', `Resolving ${ref}…`);
        let sha = '';
        let message = '';
        if (sourceType === 'git') {
          externalSource = await drivers.prepareExternalSource({
            gitUrl: serviceFresh.git_url, ref,
            rootDir: serviceFresh.root_dir || '.',
            dockerfilePath: serviceFresh.dockerfile_path || 'Dockerfile',
            signal: entry.controller.signal,
          });
          ({ sha, message } = externalSource);
        } else if (sourceType === 'repo') {
          ({ sha, message } = await drivers.resolveRef(repo.space_uid, repo.uid, ref));
        } else if (sourceType !== 'image') {
          throw new Error('Unsupported deployment source type');
        }
        throwIfCancelled(entry);

        imageTag = makeImageTag(serviceFresh.id, deploymentId);
        await updateDeployments(deploymentId, {
          sha: { v: sha },
          message: { v: String(message || '').slice(0, 300) },
          status: { v: 'building' },
          image_tag: { v: imageTag },
        });
        bus.publishStatus(serviceFresh.id, 'building', { deploymentId });

        if (sourceType === 'image') {
          await buildImage({ docker, service: serviceFresh, imageTag, entry, pull: true });
        } else {
          await buildImage({ docker, service: serviceFresh, repo, sha, imageTag, entry, externalSource });
        }
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
      throwIfCancelled(entry);
      entry.previousId = serviceFresh.current_deployment_id;
      if (serviceFresh.deployment_strategy === 'recreate') {
        // One durable intent write precedes every stop/start. Do not restore the
        // old pointer after this point, even if the candidate never gets healthy.
        await updateServices(serviceFresh.id, {
          desired_state: 'stopped', current_deployment_id: null, updated: now(),
        });
        entry.recreateIntent = true;
        targetCache.delete(String(serviceFresh.id));
        await quiesceService(docker, { ...serviceFresh, current_deployment_id: entry.previousId });
      }
      throwIfCancelled(entry);
      const info = await launchContainer({
        docker,
        service: serviceFresh,
        repo,
        deploymentId,
        imageTag,
        env,
        entry,
      });
      bus.publishLog(
        serviceFresh.id,
        'release',
        `Waiting for the app to answer on :${serviceFresh.container_port}…`,
      );
      await waitForHealth({ docker, service: serviceFresh, info, entry });
      throwIfCancelled(entry);

      // ---- swap ----
      const previousId = entry.previousId;
      await updateDeployments(deploymentId, {
        status: { v: 'live' },
        finished: { v: now() },
        duration_ms: { v: Math.max(0, now() - startedAt) },
      });
      throwIfCancelled(entry);
      await updateServices(serviceFresh.id, {
        current_deployment_id: { v: deploymentId },
        desired_state: { v: 'running' },
        status: { v: 'running' },
        last_failed_deployment_id: { v: null },
        updated: { v: now() },
      });
      targetCache.delete(String(serviceFresh.id));
      bus.publishStatus(serviceFresh.id, 'live', { deploymentId, previousId });
      bus.publishLog(
        serviceFresh.id,
        'release',
        `Live${dep.sha ? `, serving ${(dep.sha || '').slice(0, 7)}` : ''}.`,
      );

      if (!entry.recreateIntent && previousId && String(previousId) !== String(deploymentId)) {
        await retireOldContainer(serviceFresh.id, previousId);
      }
      await pruneServiceImages(docker, serviceFresh.id, deploymentId).catch(() => {});
    } catch (err) {
      await settleFailure(service, dep, entry, err);
    } finally {
      if (externalSource) {
        try { await externalSource.cleanup(); }
        catch (err) { console.error(`external source cleanup svc#${service.id}:`, err.message); }
      }
      if (activeRuns.get(String(service.id)) === entry) activeRuns.delete(String(service.id));
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
      const fresh = await getService(service.id);
      const stopped = entry.recreateIntent || fresh?.desired_state === 'stopped';
      const wasServing = !stopped && Boolean(fresh?.current_deployment_id);
      await updateServices(service.id, {
        status: { v: stopped ? 'stopped' : wasServing ? 'running' : cancelled ? 'idle' : 'failed' },
        ...(cancelled ? {} : { last_failed_deployment_id: { v: entry.deploymentId } }),
        updated: { v: now() },
      });
      bus.publishStatus(service.id, cancelled ? 'cancelled' : 'failed', {
        deploymentId: entry.deploymentId,
        error: cancelled ? undefined : message,
        servingPrevious: wasServing,
      });
      targetCache.delete(String(service.id));
      if (!err.preserveContainer) {
        if (entry.recreateIntent) {
          await stopContainer(await requireDocker(), containerName(service.id, entry.deploymentId));
        } else {
          await removeContainerIfExists(service.id, containerName(service.id, entry.deploymentId));
        }
      }
    } catch (err2) {
      console.error('failure handling error:', err2.message);
    }
  }

  function throwIfCancelled(entry) {
    if (entry.cancelled || entry.controller.signal.aborted) throw new Cancelled();
  }

  async function buildImage({ docker, service, repo, sha, imageTag, entry, externalSource, pull = false }) {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new Error('Image build/pull timed out')), buildTimeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([entry.controller.signal, deadline.signal]);
    let tarStream;
    let res;
    let progress;
    let logText = '';
    let onAbort;
    const append = text => {
      if (!text) return;
      text = String(text).slice(0, 16_384);
      logText = (logText + text + '\n').slice(-900_000);
      bus.publishLog(service.id, 'build', text.trimEnd().slice(0, 300));
    };
    try {
      const aborted = new Promise((_, reject) => {
        onAbort = () => {
          tarStream?.destroy();
          res?.destroy();
          progress?.destroy();
          reject(entry.controller.signal.aborted ? new Cancelled() : signal.reason);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      await Promise.race([aborted, (async () => {
        signal.throwIfAborted();
        if (pull) {
          if (!service.image_ref) throw new Error('An image reference is required');
          res = await docker.pull(service.image_ref);
        } else {
          let buildargs;
          if (externalSource) {
            // The classic builder does not supply BuildKit's automatic target
            // args. The daemon may run on a different architecture than core.
            let info;
            try { info = await docker.info(); }
            catch (cause) { throw new Error('Cannot read Docker daemon architecture for external Git build', { cause }); }
            const arch = new Map([['x86_64', 'amd64'], ['amd64', 'amd64'],
              ['aarch64', 'arm64'], ['arm64', 'arm64']]).get(info?.Architecture);
            if (!arch || info?.OSType !== 'linux') {
              throw new Error('External Git builds require a Linux Docker daemon reporting amd64 or arm64 architecture');
            }
            buildargs = { TARGETARCH: arch, TARGETPLATFORM: `${info.OSType}/${arch}` };
            signal.throwIfAborted();
          }
          tarStream = externalSource ? await externalSource.archive() : await drivers.archiveTar(
            repo.space_uid, repo.uid, archiveSpec(sha, normalizeRootDir(service.root_dir)), signal,
          );
          if (signal.aborted) { tarStream.destroy(); signal.throwIfAborted(); }
          res = await docker.buildImage(tarStream, {
            t: imageTag,
            dockerfile: service.dockerfile_path || 'Dockerfile',
            ...(service.build_target ? { target: service.build_target } : {}),
            ...(buildargs ? { buildargs } : {}),
          });
        }
        if (signal.aborted) { res.destroy(); signal.throwIfAborted(); }
        if (pull) {
          // followProgress retains parsed events internally; bound its input too.
          let bytes = 0;
          progress = new Transform({ transform(chunk, _encoding, cb) {
            bytes += chunk.length;
            cb(bytes > 8_000_000 ? new Error('Docker pull progress exceeds limit') : null,
              bytes > 8_000_000 ? undefined : chunk);
          } });
          res.once('error', err => progress.destroy(err));
          await new Promise((resolve, reject) => {
            docker.modem.followProgress(progress,
              err => err ? reject(err) : resolve(),
              event => {
                append(event.errorDetail?.message || event.error ||
                  [event.id, event.status, event.progress].filter(Boolean).join(' '));
                if (event.error || event.errorDetail) {
                  const err = new Error(event.errorDetail?.message || event.error);
                  reject(err);
                  progress.destroy();
                  res.destroy();
                }
              },
            );
            res.pipe(progress);
          });
          signal.throwIfAborted();
          // Tag the immutable image ID, never launch or prune the shared registry tag.
          const image = await docker.getImage(service.image_ref).inspect();
          signal.throwIfAborted();
          const colon = imageTag.lastIndexOf(':');
          await docker.getImage(image.Id).tag({ repo: imageTag.slice(0, colon), tag: imageTag.slice(colon + 1) });
        } else {
          await new Promise((resolve, reject) => {
            let buf = '';
            res.on('data', chunk => {
              buf += chunk.toString('utf8');
              if (buf.length > 1_000_000) { res.destroy(new Error('Docker build log frame too large')); return; }
              let idx;
              while ((idx = buf.indexOf('\n')) >= 0) {
                const raw = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!raw) continue;
                let evt;
                try { evt = JSON.parse(raw); } catch { evt = { stream: raw }; }
                append(evt.stream ?? evt.errorDetail?.message ?? evt.error);
                if (evt.error) { reject(new Error(evt.error)); return; }
              }
            });
            res.on('end', resolve);
            res.on('error', reject);
          });
        }
      })()]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      tarStream?.destroy();
      res?.destroy();
      progress?.destroy();
      try { await saveBuildLog(service.id, entry.deploymentId, logText); }
      catch { /* Logging must not hide the build/pull outcome. */ }
    }
  }

  async function saveBuildLog(serviceId, deploymentId, logText) {
    await updateDeployments(deploymentId, {
      build_log: { v: logText.slice(-900_000) },
    });
    void serviceId;
  }

  function validateServiceRuntime(service) {
    const ro = getRuntimeOptions(service);
    if (ro?.health_type === 'invalid') throw new Error('Invalid stored health configuration');
    if (service.volume_path) {
      if (service.deployment_strategy !== 'recreate') throw new Error('Managed volumes require recreate deployment strategy');
      if (typeof service.volume_path !== 'string' || !service.volume_path.startsWith('/') ||
          service.volume_path === '/' || service.volume_path.length > 500 ||
          /[\x00-\x20\x7f\\:]/.test(service.volume_path) || service.volume_path.split('/').includes('..')) {
        throw new Error('volume_path must be a safe absolute container mount path');
      }
      if (ro?.host_config?.binds.some(b => b.split(':')[1] === service.volume_path) ||
          Object.hasOwn(ro?.host_config?.tmpfs || {}, service.volume_path)) {
        throw new Error('Managed volume conflicts with another runtime mount');
      }
    }
    if (service.source_type && service.source_type !== 'repo' && ro?.host_config?.network_mode) {
      throw new Error('Standalone services must use the approved shared apps network');
    }
    if (service.template) {
      if (service.template !== 'postgres' || service.source_type !== 'image' ||
          !/^(?:docker\.io\/library\/)?postgres:(?:16|17)$/.test(service.image_ref || '')) {
        throw new Error('Postgres template requires an approved postgres:16 or postgres:17 image');
      }
      if (!service.volume_path || service.deployment_strategy !== 'recreate') {
        throw new Error('Postgres template requires a retained volume and recreate strategy');
      }
      if (ro?.host_config?.privileged) throw new Error('Postgres template cannot be privileged');
    }
  }

  async function launchContainer({ docker, service, repo, deploymentId, imageTag, env, entry }) {
    validateServiceRuntime(service);
    const name = containerName(service.id, deploymentId);
    // Never destroy an existing container during recovery: an inspection error
    // or a concurrent reconciler must not turn into loss of its writable layer.
    let existing;
    try {
      existing = await docker.getContainer(name).inspect();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
    if (existing) {
      throw Object.assign(new Error(`Container '${name}' already exists; reconcile it instead of replacing it`), { preserveContainer: true });
    }
    const net = await getNetwork(docker);
    const ro = getRuntimeOptions(service);
    const hc = ro?.host_config || null;

    // The migration stamps existing services with policy 1 and new services
    // default to 2. Recreating an old image must not silently remove the caps
    // its entrypoint needs (e.g. nginx's setgid/setuid or gosu).
    const privileged = Boolean(hc?.privileged);
    const legacySecurity = !service.template && Number(service.security_policy_version ?? 1) < 2;
    const hostConfig = {
      Memory: Number(service.memory_bytes),
      NanoCpus: Number(service.cpu_nano_cpus),
      RestartPolicy: { Name: 'unless-stopped' },
      Init: true,
      // Drop everything by default; cap_add (admin-only) re-adds selectively.
      CapDrop: hc?.cap_drop?.length ? hc.cap_drop : legacySecurity ? undefined : ['ALL'],
      // Block setuid/setgid escalation. Omitted for privileged containers,
      // where it would be meaningless anyway.
      SecurityOpt: privileged || legacySecurity ? undefined : ['no-new-privileges:true'],
      // Fork-bomb ceiling. Generous for ordinary web apps and build tools.
      PidsLimit: Number(process.env.DEPLOY_PIDS_LIMIT || 512),
    };
    if (hc) {
      // Values here were validated by normalizeRuntimeOptions at API time;
      // getRuntimeOptions is the defensive re-read. An explicit network_mode
      // (host/none/container:*) replaces the default core-network attachment.
      if (hc.binds.length) hostConfig.Binds = hc.binds;
      if (privileged) hostConfig.Privileged = true;
      if (hc.cap_add.length) hostConfig.CapAdd = hc.cap_add;
      if (hc.devices.length) hostConfig.Devices = hc.devices;
      if (hc.group_add.length) hostConfig.GroupAdd = hc.group_add;
      if (hc.extra_hosts.length) hostConfig.ExtraHosts = hc.extra_hosts;
      if (hc.shm_size != null) hostConfig.ShmSize = hc.shm_size;
      if (Object.keys(hc.tmpfs).length) hostConfig.Tmpfs = hc.tmpfs;
      if (hc.network_mode) hostConfig.NetworkMode = hc.network_mode;
      // Requires the operator-installed NVIDIA Container Toolkit; no detection/fallback.
      if (hc.gpus === 'all') hostConfig.DeviceRequests = [{ Driver: 'nvidia', Count: -1, Capabilities: [['gpu']] }];
    }
    if (service.template === 'postgres') {
      hostConfig.CapDrop = ['ALL'];
      hostConfig.CapAdd = POSTGRES_CAPS;
    }
    if (service.volume_path) {
      const volumeName = `nixre-service-${service.id}-data`;
      let volume;
      try { volume = await docker.getVolume(volumeName).inspect(); }
      catch (err) {
        if (err.statusCode !== 404) throw err;
        await docker.createVolume({ Name: volumeName,
          Labels: { 'nixre.deploy': 'true', 'nixre.service': String(service.id) } });
        volume = await docker.getVolume(volumeName).inspect();
      }
      if (volume.Labels?.['nixre.deploy'] !== 'true' || volume.Labels?.['nixre.service'] !== String(service.id)) {
        throw new Error('Managed volume ownership labels do not match this service');
      }
      hostConfig.Mounts = [{ Type: 'volume', Source: volumeName, Target: service.volume_path }];
    }
    // `undefined` values are not valid in the Docker API payload.
    if (hostConfig.SecurityOpt === undefined) delete hostConfig.SecurityOpt;
    if (hostConfig.CapDrop === undefined) delete hostConfig.CapDrop;

    const createOpts = {
      name,
      Image: imageTag,
      Labels: {
        'nixre.deploy': 'true',
        'nixre.service': String(service.id),
        'nixre.deployment': String(deploymentId),
        ...(repo ? { 'nixre.repo': `${repo.space_uid}/${repo.uid}` } : {}),
        ...(service.space_uid ? { 'nixre.space': service.space_uid } : {}),
        'nixre.name': service.name,
      },
      Env: env,
      HostConfig: hostConfig,
    };
    if (ro?.command) createOpts.Cmd = ro.command;
    if (ro?.entrypoint) createOpts.Entrypoint = ro.entrypoint;
    const healthCommand = service.template === 'postgres' ? POSTGRES_HEALTH : ro?.health_command;
    if (healthCommand) {
      createOpts.Healthcheck = { Test: healthCommand, Interval: 2_000_000_000,
        Timeout: 2_000_000_000, Retries: 3 };
    }
    // Explicit network modes conflict with EndpointsConfig — omit ours then.
    if (net && !(hc && hc.network_mode)) {
      createOpts.NetworkingConfig = { EndpointsConfig: { [net]: service.deployment_strategy === 'recreate'
        ? { Aliases: [`nixre-svc-${service.id}`] } : {} } };
    }
    if (entry) throwIfCancelled(entry);
    const created = await docker.createContainer(createOpts);
    if (entry) throwIfCancelled(entry);
    await created.start();
    return created.inspect();
  }

  async function waitForHealth({ docker, service, info, entry }) {
    const net = await getNetwork(docker);
    const networks = info.NetworkSettings?.Networks || {};
    const ip = getRuntimeOptions(service)?.host_config?.network_mode
      ? Object.values(networks).map(n => n.IPAddress).find(Boolean)
      : networks[net]?.IPAddress;
    const ro = getRuntimeOptions(service);
    const healthType = service.template === 'postgres' ? 'docker' : ro?.health_type || 'http';
    if (!ip && healthType !== 'docker') throw new Error('Container has no routable IP yet');
    const probePath = ro?.health_path || '/';
    const budgetMs = ro?.health_timeout_ms || healthTimeoutMs;
    const deadline = Date.now() + budgetMs;
    let lastErr = '';
    while (Date.now() < deadline) {
      throwIfCancelled(entry);
      try {
        const out = await probeService(service, docker, { ip, port: service.container_port,
          deploymentId: entry.deploymentId }, entry.controller.signal, Math.min(2500, deadline - Date.now()));
        throwIfCancelled(entry);
        if (out.ok === true) {
          bus.publishLog(
            service.id,
            'release',
            `Health probe (${healthType}) passed ${out.status ?? ''}; releasing.`,
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

  async function probeService(service, docker, target, signal, timeoutMs = 3000) {
    const ro = getRuntimeOptions(service);
    const type = service.template === 'postgres' ? 'docker' : ro?.health_type || 'http';
    if (type === 'docker') {
      const info = await docker.getContainer(containerName(service.id, target.deploymentId)).inspect();
      return { ok: info.State?.Status === 'running' && info.State?.Health?.Status === 'healthy', status: null };
    }
    if (!['http', 'tcp'].includes(type)) throw new Error('Invalid stored health configuration');
    const prober = await (type === 'tcp' ? drivers.probeTcp() : drivers.probeHttp());
    return prober({ host: target.ip, port: target.port, path: ro?.health_path || '/', timeoutMs: Math.max(1, timeoutMs), signal });
  }

  async function stopContainer(docker, name) {
    try {
      const c = docker.getContainer(name);
      try { await c.stop({ t: 10 }); }
      catch (err) { if (err.statusCode !== 304) throw err; }
      // Never force-remove a stateful container when stopping it failed.
      await c.remove();
    } catch (err) {
      if (err.statusCode !== 404) throw err;
    }
  }

  async function quiesceService(docker, service) {
    const names = new Set();
    if (service.current_deployment_id) names.add(containerName(service.id, service.current_deployment_id));
    const containers = await docker.listContainers({ all: true, filters: {
      label: [`nixre.service=${service.id}`],
    } });
    for (const c of containers) {
      if (c.Labels?.['nixre.service'] === String(service.id)) {
        names.add(c.Names?.[0]?.replace(/^\//, '') || c.Id);
      }
    }
    for (const name of names) await stopContainer(docker, name);
    targetCache.delete(String(service.id));
  }

  async function retireOldContainer(serviceId, oldDeploymentId) {
    targetCache.delete(String(serviceId));
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
    targetCache.delete(String(serviceId));
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
        if (m) ours.push({ tag, dep: m[1] });
      }
    }
    ours.sort((a, b) => BigInt(a.dep) > BigInt(b.dep) ? -1 : BigInt(a.dep) < BigInt(b.dep) ? 1 : 0);
    const current = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [currentDeploymentId])).rows[0];
    for (const item of ours.slice(keepImages)) {
      if (item.dep === String(currentDeploymentId) || item.tag === current?.image_tag) continue;
      const shared = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE image_tag = $1 AND id <> $2`,
        [item.tag, item.dep])).rows.length > 0;
      if (shared) continue;
      try {
        await docker.getImage(item.tag).remove();
      } catch {
        /* in use or gone */
      }
    }
  }

  // --- sweep ------------------------------------------------------------------

  async function sweep(clockNow) {
    const ts = clockNow ?? now();

    // 1) Runs that were mid-flight when a previous core process died.
    const { rows: stuck } = await pool.query(
      `SELECT * FROM ${DEP_TABLE} WHERE status IN ('queued','building','releasing')`,
    );

    let docker = null;
    try {
      docker = await drivers.getDocker();
    } catch {
      docker = null;
    }

    const { rows: services } = await pool.query(`SELECT * FROM ${SERVICE_TABLE}`);
    for (const service of services) {
      if (isBusy(service.id)) continue;
      await maintain(service.id, async () => {
        const fresh = await getService(service.id);
        if (!fresh) return;
        for (const row of stuck.filter(d => String(d.service_id) === String(service.id))) {
          // A run may have finished after the sweep's initial SELECT but before
          // we acquired this service. Never stop that newly promoted release.
          const latest = (await pool.query(`SELECT * FROM ${DEP_TABLE} WHERE id = $1`, [row.id])).rows[0];
          if (!latest || !['queued', 'building', 'releasing'].includes(latest.status) ||
              String(fresh.current_deployment_id) === String(row.id)) continue;
          // Never lose the interrupted candidate's identity before quiescing it.
          if (docker) await stopContainer(docker, containerName(service.id, row.id));
          else if (fresh.deployment_strategy === 'recreate') continue;
          await updateDeployments(row.id, { status: 'failed', error: 'Interrupted by restart',
            finished: ts, duration_ms: Math.max(0, ts - row.started) });
        }
        if (docker) await sweepService(fresh, { docker, ts });
      });

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
      // Includes candidates whose current pointer was deliberately cleared.
      await quiesceService(docker, service);
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
        const repo = service.repo_id ? await getRepoById(service.repo_id) : null;
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
        targetCache.delete(String(service.id));
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

    // Attach legacy containers in place: preserve their writable layer, mounts,
    // identity, and existing capability policy. Explicit admin network modes
    // are intentional and must not be rewritten by reconciliation.
    if (!getRuntimeOptions(service)?.host_config?.network_mode) {
      try {
        const approved = await getNetwork(docker);
        if (!info.NetworkSettings?.Networks?.[approved]) {
          await docker.getNetwork(approved).connect({ Container: info.Id,
            EndpointConfig: service.deployment_strategy === 'recreate'
              ? { Aliases: [`nixre-svc-${service.id}`] } : {} });
          info = await docker.getContainer(name).inspect();
          if (!info.NetworkSettings?.Networks?.[approved]) throw new Error('Network attachment was not applied');
        }
        // Once the new route exists, remove obsolete shared/data attachments.
        for (const old of Object.keys(info.NetworkSettings?.Networks || {})) {
          if (old !== approved) await docker.getNetwork(old).disconnect({ Container: info.Id });
        }
      } catch (err) {
        targetCache.delete(String(service.id));
        console.error(`network reconcile failed for svc#${service.id}:`, err.message);
        await updateServices(service.id, { status: { v: 'failed' }, updated: { v: ts } });
        return;
      }
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
    targetCache.delete(String(service.id));
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
      if (svc.source_type && svc.source_type !== 'repo') continue;
      if (!svc.auto_deploy) continue;
      if (svc.branch !== branch) continue;
      if (svc.desired_state !== 'running') continue;
      if (isBusy(svc.id)) continue;
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
    if (service.desired_state === 'stopped' || service.status === 'stopped' || !service.current_deployment_id) return null;
    const cached = targetCache.get(String(service.id));
    if (cached && String(cached.target?.deploymentId) === String(service.current_deployment_id) && now() - cached.ts < 2000) return cached.target;
    let target = null;
    if (service.current_deployment_id && docker) {
      try {
        const name = containerName(service.id, service.current_deployment_id);
        const info = await docker.getContainer(name).inspect();
        if (info.State?.Status === 'running') {
          const net = await getNetwork(docker);
          const networks = info.NetworkSettings?.Networks || {};
          const ip = getRuntimeOptions(service)?.host_config?.network_mode
            ? Object.values(networks).map(n => n.IPAddress).find(Boolean)
            : networks[net]?.IPAddress;
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
    targetCache.set(String(service.id), { ts: now(), target });
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
      if (target || service.template === 'postgres' || getRuntimeOptions(service)?.health_type === 'docker') {
        try {
          outcome = await probeService(service, docker, target || { deploymentId: service.current_deployment_id });
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
        const ring = metricRings.get(String(service.id)) || [];
        ring.push({ ts: Date.now(), ...usage });
        if (ring.length > MAX_METRIC_POINTS) ring.splice(0, ring.length - MAX_METRIC_POINTS);
        metricRings.set(String(service.id), ring);
        bus.publishMetrics(service.id, usage);
      } catch {
        /* container gone or stats unavailable this tick */
      }
    }
  }

  function getStatsSnapshot(serviceId) {
    const ring = metricRings.get(String(serviceId)) || [];
    return { latest: ring.at(-1) || null, series: ring.slice(-120) };
  }

  // For the central proxy: route resolution target for one service.
  async function findServiceTarget(serviceId) {
    const service = await getService(serviceId);
    if (!service || service.exposure === 'internal' || service.desired_state === 'stopped' || service.status === 'stopped') return null;
    const docker = await drivers.getDocker().catch(() => null);
    if (!docker) return null;
    return serviceTarget(service, docker);
  }

  // Authorization belongs to the route: container output can contain secrets.
  async function runtimeLogs(serviceId, { tail = 200 } = {}) {
    const service = await getService(serviceId);
    if (!service) throw Object.assign(new Error('No such service'), { status: 404 });
    const deploymentId = service.current_deployment_id || activeRuns.get(String(serviceId))?.deploymentId;
    if (!deploymentId) return '';
    const docker = await requireDocker();
    try {
      const c = docker.getContainer(containerName(serviceId, deploymentId));
      const info = await c.inspect();
      const logs = await c.logs({ stdout: true, stderr: true, follow: false,
        tail: Number.isFinite(Number(tail)) ? Math.min(1000, Math.max(1, Math.trunc(Number(tail)))) : 200 });
      const stream = Buffer.isBuffer(logs) || typeof logs === 'string' ? Readable.from([logs]) : logs;
      let output = Buffer.alloc(0);
      const sink = new Writable({ write(chunk, _encoding, callback) {
        output = Buffer.concat([output, Buffer.from(chunk)]).subarray(-256_000);
        callback();
      } });
      await new Promise((resolve, reject) => {
        stream.once('end', resolve);
        stream.once('error', reject);
        sink.once('error', reject);
        if (info.Config?.Tty) stream.pipe(sink);
        else docker.modem.demuxStream(stream, sink, sink);
      });
      return output.toString('utf8');
    } catch (err) {
      if (err.statusCode === 404) return '';
      throw err;
    }
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
    runtimeLogs,
    isBusy,
    waitIdle,
    waitAllIdle,
    invalidateTarget: serviceId => targetCache.delete(String(serviceId)),
  };
}

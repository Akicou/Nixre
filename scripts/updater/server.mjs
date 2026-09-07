import http from 'node:http';
import { readFile, writeFile, mkdir, rename, rm, chmod, chown, stat, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { executeUpdate, recoverInterrupted } from './engine.mjs';
import { HostDriver } from './driver.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function atomicJSON(filename, value) {
  const temp = `${filename}.next`;
  await writeFile(temp, JSON.stringify(value), { mode: 0o600 });
  if (process.getuid?.() === 0) {
    try { const owner = await stat(filename); await chown(temp, owner.uid, owner.gid); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const file = await open(temp, 'r');
  try { await file.sync(); } finally { await file.close(); }
  await rename(temp, filename);
  if (process.platform !== 'win32') {
    const directory = await open(path.dirname(filename), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
}

export async function createUpdater({ root, stateDir = path.join(root, 'data/updater'), key,
  driverFactory, now = Date.now } = {}) {
  if (!key || key.length < 32) throw new Error('Updater control key is missing.');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const stateFile = path.join(stateDir, 'state.json');
  let jobs = [];
  try { jobs = JSON.parse(await readFile(stateFile, 'utf8')).jobs.map(recoverInterrupted); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let saving = Promise.resolve();
  const save = () => {
    const snapshot = structuredClone({ jobs });
    saving = saving.then(() => atomicJSON(stateFile, snapshot));
    return saving;
  };
  if (jobs.some(job => job.status === 'recovery_required' && (job.quiesced || ['uncertain', 'committed'].includes(job.database)))) {
    // Re-establish the write pause even after power loss removed an unflushed
    // maintenance file. Do not replay any Docker or database operation.
    const controlDir = path.join(root, 'data/update-control');
    await mkdir(controlDir, { recursive: true, mode: 0o750 });
    await atomicJSON(path.join(controlDir, 'maintenance.json'), { recoveryRequired: true });
  }
  await save();
  let busy = false;
  let operationInFlight = false;
  let shuttingDown = false;
  const sign = value => createHmac('sha256', key).update(value).digest('hex');
  const watchToken = job => {
    const value = `${job.id}.${now() + 24 * 60 * 60_000}`;
    return `${value}.${sign(value)}`;
  };
  const view = job => ({ current: job, watchToken: job ? watchToken(job) : null });
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(value));
  };
  async function body(req) {
    let value = '';
    for await (const chunk of req) {
      value += chunk;
      if (value.length > 4096) throw new Error('Request too large.');
    }
    return JSON.parse(value || '{}');
  }
  const control = http.createServer(async (req, res) => {
    if (!equal(req.headers.authorization || '', `Bearer ${key}`)) return json(res, 401, { message: 'Unauthorized' });
    if (req.method === 'POST' && req.url === '/shutdown') {
      if (busy || operationInFlight || jobs.some(job => ['checking', 'running', 'recovery_required'].includes(job.status))) {
        return json(res, 409, { message: 'Update active or recovery required; worker replacement blocked.' });
      }
      shuttingDown = true;
      json(res, 200, { ok: true });
      control.close(); status.close();
      return;
    }
    if (req.method === 'GET' && req.url === '/state') return json(res, 200, { enabled: true, ...view(jobs.at(-1)),
      history: jobs.slice(-10).reverse().map(({ id, status, startedAt, actor, message }) => ({ id, status, startedAt, actor, message })) });
    if (req.method !== 'POST' || !['/check', '/apply'].includes(req.url)) return json(res, 404, { message: 'No such updater operation.' });
    // Synchronous gate also covers requests racing while a body is being read.
    if (busy || shuttingDown) return json(res, 409, { message: 'An updater request is already being accepted or the worker is stopping.' });
    busy = true;
    try {
      const input = await body(req);
      if (!uuid.test(input.requestId || '') || typeof input.actor !== 'string' || input.actor.length > 100) throw new Error('Invalid update request.');
      const existing = jobs.find(job => job.id === input.requestId);
      if (existing) {
        if (existing.operation !== req.url) return json(res, 409, { message: 'Request id was already used for another operation.' });
        return json(res, 200, view(existing));
      }
      if (operationInFlight || jobs.some(job => ['checking', 'running', 'recovery_required'].includes(job.status))) return json(res, 409, { message: 'An update is active or requires operator recovery.' });
      let plan;
      if (req.url === '/apply') {
        plan = jobs.at(-1)?.plan;
        if (jobs.at(-1)?.status !== 'checked' || !plan?.available || plan.id !== input.planId || plan.target !== input.target || plan.base !== input.expectedBase) {
          return json(res, 409, { message: 'Update review no longer matches. Check for updates again.' });
        }
      }
      const job = { id: input.requestId, operation: req.url, actor: input.actor, startedAt: now(),
        status: plan ? 'running' : 'checking', steps: [], ...(plan ? { plan } : {}) };
      jobs.push(job);
      jobs = jobs.slice(-20);
      await save();
      const driver = driverFactory ? driverFactory(job) : new HostDriver({ root, stateDir,
        logFile: path.join(stateDir, `${job.id}.log`),
        repository: process.env.NIXRE_UPDATE_REPOSITORY || 'Akicou/Nixre',
        publicUrl: process.env.NIXRE_UPDATE_PUBLIC_URL || 'http://127.0.0.1:3000' });
      json(res, 202, view(job));
      operationInFlight = true;
      const operation = plan ? executeUpdate(driver, job, save) : (async () => {
        try { job.plan = await driver.plan(); job.status = 'checked'; }
        catch (error) { job.status = 'failed'; job.message = error.message; }
        job.finishedAt = now();
        await save();
      })();
      operation.catch(() => {
        // Persistence failure is fatal: restart marks the last durable active
        // state as interrupted. Never carry on with unrecorded mutations.
        control.close(); status.close();
        process.exitCode = 1;
      }).finally(() => { operationInFlight = false; });
    } catch (error) { json(res, 400, { message: error.message }); }
    finally { busy = false; }
  });
  // This server has no mutation routes and never accepts the control key.
  // Caddy can expose this socket even while the core and its auth DB are down.
  const status = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/update-status/health') return json(res, 200, { ok: true, protocol: 1 });
    if (req.method !== 'GET' || req.url !== '/update-status/current') return json(res, 404, { message: 'Not found' });
    const token = (req.headers.authorization || '').replace(/^Bearer /, '');
    const [id, expires, signature] = token.split('.');
    if (!uuid.test(id || '') || !/^\d{13}$/.test(expires || '') || Number(expires) <= now() || !equal(signature || '', sign(`${id}.${expires}`))) {
      return json(res, 401, { message: 'Progress access expired. Sign in as an administrator to reconnect.' });
    }
    const job = jobs.find(item => item.id === id);
    return job ? json(res, 200, job) : json(res, 410, { message: 'This update is no longer in recent history.' });
  });
  control.requestTimeout = status.requestTimeout = 15_000;
  control.headersTimeout = status.headersTimeout = 10_000;
  return { control, status };
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node 22 or newer is required.');
  const root = path.resolve(process.env.NIXRE_DIR || '/opt/nixre');
  const controlDir = path.join(root, 'data/update-control');
  const publicDir = path.join(root, 'data/update-status');
  const stateDir = path.join(root, 'data/updater');
  if (process.argv.includes('--ack-recovery')) {
    if (!process.argv.includes('--services-verified')) throw new Error('Verify database, services, and checkout first; then pass --services-verified with the service stopped.');
    if (!process.argv.includes('--recovery-lock-held')) {
      const result = spawnSync('flock', ['-n', path.join(stateDir, 'daemon.lock'), process.execPath,
        process.argv[1], '--ack-recovery', '--services-verified', '--recovery-lock-held'], { stdio: 'inherit' });
      if (result.error || result.status !== 0) throw new Error('Recovery acknowledgement failed. Stop the host worker before acknowledging recovery.');
      return;
    }
    const filename = path.join(stateDir, 'state.json');
    const state = JSON.parse(await readFile(filename, 'utf8'));
    state.jobs = state.jobs.map(job => ['running', 'checking', 'recovery_required'].includes(job.status)
      ? { ...job, status: 'failed', message: 'Operator acknowledged recovery after verifying services.', finishedAt: Date.now() } : job);
    await atomicJSON(filename, state);
    await rm(path.join(controlDir, 'maintenance.json'), { force: true });
    return;
  }
  const key = (await readFile(path.join(controlDir, 'key'), 'utf8')).trim();
  const servers = await createUpdater({ root, stateDir, key });
  for (const [server, filename, mode] of [[servers.control, path.join(controlDir, 'control.sock'), 0o660],
    [servers.status, path.join(publicDir, 'status.sock'), 0o666]]) {
    // The systemd ExecStart holds flock for this instance before socket cleanup.
    await rm(filename, { force: true });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(filename, resolve); });
    if (process.getuid() === 0) await chown(filename, 0, 1000);
    await chmod(filename, mode);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

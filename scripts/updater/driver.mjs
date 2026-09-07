import { spawn } from 'node:child_process';
import { open, readFile, writeFile, mkdir, readdir, stat, statfs, cp, symlink, rename, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream, writeSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const shaPattern = /^[a-f0-9]{40}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
export function assertDatabaseConfiguration(config) {
  const core = config.services['nixre-core']?.environment || {};
  const db = config.services['nixre-db']?.environment || {};
  if (core.DATABASE_URL || core.PGHOST !== 'nixre-db' || String(core.PGPORT || '5432') !== '5432' ||
      !db.POSTGRES_USER || !db.POSTGRES_DB || core.PGUSER !== db.POSTGRES_USER || core.PGDATABASE !== db.POSTGRES_DB ||
      !core.PGPASSWORD || core.PGPASSWORD !== db.POSTGRES_PASSWORD) {
    throw new Error('Automatic updates require the local Compose database with matching PG variables. External URLs or mismatched database settings require a manual upgrade.');
  }
}
export function assertUpgrade(base, target, files) {
  if (!shaPattern.test(base) || !shaPattern.test(target)) throw new Error('Invalid revision.');
  const infrastructure = /^(?:docker-compose[^/]*\.(?:yml|yaml)|Caddyfile|\.env\.example|update-nixre\.sh|ssh\/|scripts\/(?:updater\/|install-updater\.sh)|backend\/(?:Dockerfile|entrypoint\.sh))/;
  if (files.some(file => infrastructure.test(file.path))) {
    throw new Error('Infrastructure or updater changes require a manual upgrade. Review Compose, Caddy, host worker, and SSH changes first.');
  }
  if (files.some(file => file.path.startsWith('backend/src/db/migrations/') && file.status !== 'A')) {
    throw new Error('Existing migrations were changed or removed. Manual review is required.');
  }
}

export class HostDriver {
  constructor({ root, stateDir, publicUrl = 'http://127.0.0.1:3000', repository = 'Akicou/Nixre', logFile, fetchImpl = fetch }) {
    Object.assign(this, { root, stateDir, publicUrl, repository, logFile, fetchImpl });
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid configured GitHub repository.');
    const url = new URL(publicUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
      throw new Error('The updater edge probe must use local HTTP.');
    }
  }

  // No shell, no browser-supplied commands. Raw output is private (0600), never
  // returned through the observation endpoint, and capture sizes are bounded.
  async run(command, args, { cwd = this.root, timeout = 120_000, inputFile, outputFile, quiet = false, allowFailure = false } = {}) {
    const log = await open(this.logFile, 'a', 0o600);
    if (command === 'git') args = ['-c', `safe.directory=${cwd}`, ...args];
    let output = '';
    let size = 0;
    const child = spawn(command, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const timer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
    }, timeout);
    const capture = chunk => {
      if (!quiet) writeSync(log.fd, chunk);
      size += chunk.length;
      if (size < 4 * 1024 * 1024) output += chunk.toString();
    };
    const transfers = [];
    child.stderr.on('data', quiet ? () => {} : capture);
    if (outputFile) transfers.push(pipeline(child.stdout, createWriteStream(outputFile, { mode: 0o600, flags: 'wx' })));
    else child.stdout.on('data', capture);
    if (inputFile) transfers.push(pipeline(createReadStream(inputFile), child.stdin));
    else child.stdin.end();
    // Attach rejection handlers immediately: an early pg_restore failure can
    // close stdin before the child emits close.
    let transferError;
    const transferred = Promise.all(transfers).catch(error => { transferError = error; });
    try {
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', resolve);
      });
      await transferred;
      if (transferError) throw transferError;
      if (code !== 0 && !allowFailure) throw new Error(`${command} operation failed (${code ?? 'timeout'}). See the private worker log.`);
      return { code, output: output.trim() };
    } finally { clearTimeout(timer); await log.close(); }
  }
  async git(...args) { return (await this.run('git', args)).output; }
  async configuration() {
    const args = ['compose', '--project-directory', this.root, '--env-file', path.join(this.root, '.env'),
      '-f', path.join(this.root, 'docker-compose.yml')];
    try { await stat(path.join(this.root, 'docker-compose.override.yml')); args.push('-f', path.join(this.root, 'docker-compose.override.yml')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const raw = (await this.run('docker', [...args, 'config', '--format', 'json'], { quiet: true })).output;
    const config = JSON.parse(raw);
    const core = config.services['nixre-core'];
    const db = config.services['nixre-db'];
    if (!core || !db || !config.services['nixre-ssh']) throw new Error('Required Compose services are missing.');
    assertDatabaseConfiguration(config);
    return { args, config, raw, fingerprint: digest(raw) };
  }
  async checkCI(target) {
    const url = `https://api.github.com/repos/${this.repository}/actions/workflows/ci.yml/runs?head_sha=${target}&event=push&branch=main&per_page=10`;
    const response = await this.fetchImpl(url, { headers: { Accept: 'application/vnd.github+json',
      ...(process.env.NIXRE_UPDATE_GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.NIXRE_UPDATE_GITHUB_TOKEN}` } : {}) },
    signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!response.ok) throw new Error('Could not verify GitHub CI. Update is blocked; retry after connectivity/rate limits recover.');
    const data = await response.json();
    const latest = data.workflow_runs?.filter(run => run.head_sha === target && run.event === 'push' && run.head_branch === 'main')
      .sort((a, b) => b.id - a.id)[0];
    if (!latest || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error('The latest main-branch CI run for this exact revision has not passed.');
    }
    return latest.html_url;
  }
  async plan() {
    if (await this.git('status', '--porcelain')) throw new Error('Checkout has uncommitted changes. Preserve them before updating.');
    if (await this.git('branch', '--show-current') !== 'main') throw new Error('Automatic updates require the main branch.');
    const origin = await this.git('remote', 'get-url', 'origin');
    if (![ `https://github.com/${this.repository}.git`, `https://github.com/${this.repository}`, `git@github.com:${this.repository}.git` ].includes(origin)) {
      throw new Error('Origin does not match the configured trusted GitHub repository.');
    }
    await this.git('fetch', '--no-tags', 'origin', 'main');
    const base = await this.git('rev-parse', 'HEAD');
    const target = await this.git('rev-parse', 'FETCH_HEAD');
    if ((await this.run('git', ['merge-base', '--is-ancestor', base, target], { allowFailure: true })).code !== 0) {
      throw new Error('Local commits are ahead or diverged. Automatic updates never discard local work.');
    }
    const files = (await this.git('diff', '--name-status', '--no-renames', base, target)).split('\n').filter(Boolean)
      .map(line => { const [status, filename] = line.split('\t'); return { status, path: filename }; });
    assertUpgrade(base, target, files);
    const ciUrl = await this.checkCI(target);
    const configuration = await this.configuration();
    const pending = files.filter(file => file.path.startsWith('backend/src/db/migrations/')).map(file => path.basename(file.path));
    return { id: randomUUID(), createdAt: Date.now(), base, target, available: base !== target,
      files: files.slice(0, 200), totalFiles: files.length, migrations: pending, ciUrl, configFingerprint: configuration.fingerprint };
  }
  async edge(pathname, token) {
    const res = await this.fetchImpl(new URL(pathname, this.publicUrl), { signal: AbortSignal.timeout(10_000), redirect: 'error',
      headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error('Independent update progress / managed UI routing is not ready. Finish the one-time Caddy setup.');
    return res.text();
  }
  async preflight(plan) {
    if (Date.now() - plan.createdAt > 10 * 60_000) throw new Error('Update review expired. Check for updates again.');
    const fresh = await this.plan();
    if (fresh.base !== plan.base || fresh.target !== plan.target || fresh.configFingerprint !== plan.configFingerprint) {
      throw new Error('Revision or deployment configuration changed after review. Check for updates again.');
    }
    if (!fresh.available) throw new Error('Already up to date.');
    if (!((await this.edge('/')).includes(`nixre-updater:${plan.base}`))) throw new Error('Managed UI does not match the current checkout. Finish setup or reconcile the previous update.');
    if (JSON.parse(await this.edge('/update-status/health')).protocol !== 1) throw new Error('Independent progress route is unavailable.');
    const cfg = await this.configuration();
    const folder = path.join(this.stateDir, 'runs', randomUUID());
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const candidate = path.join(folder, 'checkout');
    const coreId = (await this.run('docker', [...cfg.args, 'ps', '-q', 'nixre-core'])).output;
    const dbId = (await this.run('docker', [...cfg.args, 'ps', '-q', 'nixre-db'])).output;
    const sshId = (await this.run('docker', [...cfg.args, 'ps', '-q', 'nixre-ssh'])).output;
    if (!coreId || !dbId || !sshId) throw new Error('Core, database, and SSH must all be running before an update.');
    const coreInfo = JSON.parse((await this.run('docker', ['inspect', coreId], { quiet: true })).output)[0];
    const runningEnv = Object.fromEntries(coreInfo.Config.Env.map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
    if (runningEnv.DATABASE_URL || ['PGHOST', 'PGUSER', 'PGDATABASE', 'PGPASSWORD'].some(name =>
      runningEnv[name] !== cfg.config.services['nixre-core'].environment[name]?.replaceAll('$$', '$'))) {
      throw new Error('Running core database settings differ from Compose. Reconcile them before updating.');
    }
    const dbInfo = JSON.parse((await this.run('docker', ['inspect', dbId], { quiet: true })).output)[0];
    const network = cfg.config.services['nixre-core'].environment.NIXRE_DATA_NETWORK;
    if (!dbInfo.NetworkSettings.Networks[network]) throw new Error('Cannot identify the private database network.');
    const context = { ...cfg, plan, folder, candidate, dbId, coreId, sshId, oldImage: coreInfo.Image,
      dbImage: dbInfo.Image, network, rehearsalName: `nixre-update-test-${randomUUID()}`,
      image: `nixre-update-core:${plan.target}`, sandboxImage: `nixre-update-sandbox:${plan.target}` };
    // Pin resolved configuration, including credentials and absolute mounts.
    // Later host edits to .env cannot redirect a migration to another database.
    const pinned = path.join(folder, 'resolved.compose.json');
    await writeFile(pinned, cfg.raw, { mode: 0o600 });
    context.args = ['compose', '--project-directory', this.root, '--env-file', '/dev/null', '-f', pinned];
    const size = Number((await this.run('docker', this.dbArgs(context, 'psql', '-Atc',
      'SELECT pg_database_size(current_database())'), { quiet: true })).output);
    const disk = await statfs(this.root);
    if (!Number.isFinite(size) || disk.bavail * disk.bsize < size * 3 + 2 * 1024 ** 3) {
      throw new Error('Insufficient disk space for two backups, rehearsal restore, and staged builds (database size × 3 + 2 GiB minimum).');
    }
    // Root-only recovery inventory. Docker inspect / Compose can contain secrets;
    // never serialize those objects into the browser-visible state.
    await writeFile(path.join(folder, 'recovery.json'), JSON.stringify({ base: plan.base, target: plan.target,
      oldImage: context.oldImage, coreId, sshId, dbId, folder, candidate, network }), { mode: 0o600 });
    return context;
  }
  async compose(context, override, ...args) {
    return this.run('docker', [...context.args, ...(override ? ['-f', override] : []), ...args], { timeout: 20 * 60_000 });
  }
  async build(context) {
    await this.git('worktree', 'add', '--detach', context.candidate, context.plan.target);
    const ui = path.join(context.candidate, 'ui');
    await this.run('npm', ['ci'], { cwd: ui, timeout: 10 * 60_000 });
    await this.run('npm', ['test'], { cwd: ui, timeout: 10 * 60_000 });
    await this.run('npm', ['run', 'build'], { cwd: ui, timeout: 10 * 60_000 });
    if ((await this.run('git', ['status', '--porcelain', 'ui/dist'], { cwd: context.candidate })).output) {
      throw new Error('Built UI does not match committed ui/dist. Update blocked.');
    }
    for (const [image, directory] of [[context.image, 'backend'], [context.sandboxImage, 'backend/agent-sandbox']]) {
      await this.run('docker', ['build', '-t', image,
        ...(directory === 'backend' ? ['--build-arg', `NIXRE_REVISION=${context.plan.target}`] : []),
        path.join(context.candidate, directory)], { timeout: 20 * 60_000 });
    }
    context.override = path.join(context.folder, 'candidate.compose.json');
    context.previous = path.join(context.folder, 'previous.compose.json');
    await writeFile(context.override, JSON.stringify({ services: { 'nixre-core': { image: context.image,
      environment: { NIXRE_REVISION: context.plan.target } } } }), { mode: 0o600 });
    await writeFile(context.previous, JSON.stringify({ services: { 'nixre-core': { image: context.oldImage } } }), { mode: 0o600 });
    context.versions = (await readdir(path.join(context.candidate, 'backend/src/db/migrations'))).filter(f => f.endsWith('.sql')).sort();
  }
  dbArgs(context, program, ...args) {
    const env = context.config.services['nixre-db'].environment;
    return ['exec', '-i', context.dbId, program, '-U', env.POSTGRES_USER.replaceAll('$$', '$'), '-d', env.POSTGRES_DB.replaceAll('$$', '$'), ...args];
  }
  async backup(context, kind) {
    const filename = path.join(context.folder, `${kind}.dump`);
    await this.run('docker', this.dbArgs(context, 'pg_dump', '-Fc'), { outputFile: filename, timeout: 15 * 60_000 });
    if ((await stat(filename)).size < 100) throw new Error('Database backup is empty.');
    await this.run('docker', ['exec', '-i', context.dbId, 'pg_restore', '--list'], { inputFile: filename, quiet: true });
    return filename;
  }
  async migrationCommand(context, extra = []) {
    const result = await this.run('docker', [...context.args, '-f', context.override, 'run', '--rm', '--no-deps', '-T',
      '-e', 'DATABASE_URL=', ...extra, '--entrypoint', 'node', 'nixre-core', 'src/db/runMigrations.js'], { timeout: 15 * 60_000, allowFailure: true });
    const line = result.output.split('\n').findLast(value => value.startsWith('NIXRE_MIGRATION_RESULT='));
    let report;
    try { report = JSON.parse(line?.slice('NIXRE_MIGRATION_RESULT='.length)); } catch { /* uncertain result */ }
    if (result.code !== 0 || !report?.ok || JSON.stringify(report.versions?.sort()) !== JSON.stringify(context.versions)) {
      const version = /^[\w.-]+\.sql$/.test(report?.version || '') ? report.version : 'migration runner';
      const error = new Error(`Migration failed or could not be verified: ${version}${/^[A-Z0-9]{5}$/.test(report?.code || '') ? ` (SQLSTATE ${report.code})` : ''}. See the private worker log.`);
      error.rollbackConfirmed = report?.ok === false && report.rollbackConfirmed === true;
      throw error;
    }
    return report.versions;
  }
  async rehearse(context) {
    const password = randomUUID();
    await this.run('docker', ['run', '-d', '--name', context.rehearsalName, '--network', context.network,
      '-e', 'POSTGRES_USER=nixre_rehearsal', '-e', 'POSTGRES_DB=nixre_rehearsal', '-e', `POSTGRES_PASSWORD=${password}`,
      context.dbImage], { quiet: true });
    for (let attempt = 0; attempt < 60; attempt++) {
      if ((await this.run('docker', ['exec', context.rehearsalName, 'pg_isready', '-U', 'nixre_rehearsal'], { allowFailure: true })).code === 0) break;
      if (attempt === 59) throw new Error('Rehearsal database did not start.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    await this.run('docker', ['exec', '-i', context.rehearsalName, 'pg_restore', '--exit-on-error', '--no-owner', '--no-privileges',
      '-U', 'nixre_rehearsal', '-d', 'nixre_rehearsal'], { inputFile: path.join(context.folder, 'rehearsal.dump'), timeout: 15 * 60_000 });
    await this.migrationCommand(context, ['-e', `PGHOST=${context.rehearsalName}`, '-e', 'PGPORT=5432', '-e', 'PGUSER=nixre_rehearsal',
      '-e', 'PGDATABASE=nixre_rehearsal', '-e', `PGPASSWORD=${password}`]);
  }
  async guard(context) {
    await writeFile(path.join(this.root, 'data/update-control/maintenance.json'), JSON.stringify({ target: context.plan.target }), { mode: 0o640 });
    if (await this.git('rev-parse', 'HEAD') !== context.plan.base || await this.git('status', '--porcelain')) throw new Error('Checkout changed during preparation. Update stopped.');
    if ((await this.configuration()).fingerprint !== context.plan.configFingerprint) throw new Error('Compose or environment changed during preparation.');
    await this.checkCI(context.plan.target);
    const query = "SELECT (SELECT count(*) FROM conversations WHERE run_status IN ('running','stopping')) + (SELECT count(*) FROM deployments WHERE status IN ('queued','building','releasing'))";
    const result = await this.run('docker', this.dbArgs(context, 'psql', '-Atc', query), { quiet: true });
    if (result.output !== '0') throw new Error('Agent tasks or deployments are active. Wait for them to finish and retry.');
  }
  async stop(context) { await this.compose(context, null, 'stop', '-t', '30', 'nixre-core', 'nixre-ssh'); }
  async migrate(context) {
    if ((await this.configuration()).fingerprint !== context.plan.configFingerprint) {
      throw Object.assign(new Error('Deployment configuration changed before migration. Update stopped.'), { rollbackConfirmed: true });
    }
    return this.migrationCommand(context);
  }
  async activate(context) {
    // Keep normal Compose restarts on the new image too. The prior immutable
    // image ID remains retained in the recovery inventory.
    await this.run('docker', ['tag', context.image, context.config.services['nixre-core'].image]);
    await this.run('docker', ['tag', context.sandboxImage, context.config.services['nixre-core'].environment.SANDBOX_IMAGE]);
    await this.compose(context, context.override, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'nixre-core');
  }
  async health(context, expected = context.plan.target) {
    const id = (await this.compose(context, null, 'ps', '-q', 'nixre-core')).output;
    for (let i = 0; i < 60; i++) {
      const code = `fetch('http://127.0.0.1:3002/healthz').then(async r=>{const d=await r.json();process.exit(r.ok&&d.ok${expected ? `&&d.revision===${JSON.stringify(expected)}` : ''}?0:1)}).catch(()=>process.exit(1))`;
      if ((await this.run('docker', ['exec', id, 'node', '-e', code], { allowFailure: true, timeout: 10_000 })).code === 0) return;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error('Backend health or running revision check failed.');
  }
  async publish(context) {
    const releases = path.join(this.root, 'data/update-web/releases');
    const release = path.join(releases, context.plan.target);
    await mkdir(releases, { recursive: true });
    await cp(path.join(context.candidate, 'ui/dist'), release, { recursive: true });
    const index = path.join(release, 'index.html');
    await writeFile(index, `${await readFile(index, 'utf8')}\n<!-- nixre-updater:${context.plan.target} -->\n`);
    // A dirty checkout or moved HEAD must never be overwritten, even late in cutover.
    if (await this.git('rev-parse', 'HEAD') !== context.plan.base || await this.git('status', '--porcelain')) throw new Error('Checkout changed during cutover. Manual recovery required.');
    await this.git('merge', '--ff-only', context.plan.target);
    const temporary = path.join(this.root, `data/update-web/next-${randomUUID()}`);
    await symlink(`releases/${context.plan.target}`, temporary);
    await rename(temporary, path.join(this.root, 'data/update-web/current'));
    if (!(await this.edge('/')).includes(`nixre-updater:${context.plan.target}`)) throw new Error('Published UI revision could not be verified through Caddy.');
    await this.compose(context, null, 'start', 'nixre-ssh');
  }
  async resumeOld(context) {
    await this.compose(context, context.previous, 'up', '-d', '--no-deps', '--no-build', '--pull', 'never', 'nixre-core');
    await this.health(context, null);
    await this.compose(context, null, 'start', 'nixre-ssh');
  }
  async cleanup(context, job) {
    if (job.status !== 'recovery_required') await rm(path.join(this.root, 'data/update-control/maintenance.json'), { force: true });
    const result = await this.run('docker', ['rm', '-f', '-v', context.rehearsalName], { allowFailure: true });
    if (result.code !== 0 && !result.output.includes('No such container')) throw new Error('Could not remove rehearsal database.');
    // Retain candidate checkout, images, dumps, and recovery inventory for the
    // operator. Never prune images or backups as part of an update.
  }
}

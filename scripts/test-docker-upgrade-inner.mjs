// Invoked only inside the disposable test core by test-docker-upgrade.mjs.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import http from 'node:http';

const prefix = process.env.CHECK_PREFIX;
assert.match(prefix || '', /^nixre-pr1-check-[a-f0-9]{12}$/);
assert.equal(process.env.PGHOST, 'check-db');
assert.equal(process.env.NIXRE_APPS_NETWORK, `${prefix}-apps`);
// Guard before importing anything capable of a boot sweep.
const { pool } = await import('/app/src/db/pool.js');
const drivers = await import('/app/src/lib/deployDrivers.js');
const { createDeploymentEngine } = await import('/app/src/lib/deployments.js');
const { containerName } = await import('/app/src/lib/deployPure.js');
const { normalizeRuntimeOptions } = await import('/app/src/lib/deployRuntimeOptions.js');
const docker = await drivers.getDocker();
assert.ok(docker, 'unprivileged core user can access ONLY the nested socket');
const daemonInfo = await docker.info();
assert.equal(daemonInfo.Name, `${prefix}-dind`);
const pass = text => console.log(`PASS ${text}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check, description) {
  for (let i = 0; i < 40; i++) {
    try { if (await check()) return; } catch { /* wait for startup */ }
    await sleep(250);
  }
  throw new Error(`Timed out: ${description}`);
}
async function exec(container, cmd) {
  const instance = await container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true });
  const stream = await instance.start({});
  const chunks = [];
  docker.modem.demuxStream(stream, { write: c => chunks.push(c) }, { write: c => chunks.push(c) });
  await new Promise((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
  return { code: (await instance.inspect()).ExitCode, output: Buffer.concat(chunks).toString() };
}
const base = 'http://check-web:3000';
async function request(route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const r = await fetch(`${base}${route}`, { method, signal: AbortSignal.timeout(20_000),
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { /* static HTML */ }
  return { status: r.status, text, json, headers: r.headers };
}
const engine = createDeploymentEngine({ pool, drivers, healthTimeoutMs: 2500 });
try {
  await eventually(async () => (await request('/')).status === 200, 'Caddy');
  const ui = await request('/');
  assert.match(ui.text, /<html/i);
  assert.match(ui.headers.get('content-security-policy'), /default-src 'self'/);
  const asset = ui.text.match(/(?:src|href)="(\/assets\/[^\"]+\.js)"/);
  assert.ok(asset, 'built UI asset reference');
  assert.equal((await request(asset[1])).status, 200);
  pass('Caddy serves ui/dist, bundled JavaScript and security headers');
  const password = randomBytes(24).toString('hex');
  const tokens = {};
  for (const uid of ['owner', 'outsider']) {
    const r = await request('/api/v1/register', { body: { uid, email: `${uid}@example.test`, password } });
    assert.equal(r.status, 201, 'fixture registration');
    assert.ok(r.json.access_token);
    tokens[uid] = r.json.access_token;
  }
  const login = await request('/api/v1/login', { body: { login_identifier: 'owner', password } });
  assert.equal(login.status, 200);
  assert.ok(login.json.access_token);
  assert.equal((await request('/api/v1/user', { token: login.json.access_token })).json.uid, 'owner');
  const sessions = (await pool.query('SELECT id, token_hash FROM sessions')).rows;
  assert.ok(sessions.every(s => /^[a-f0-9]{64}$/.test(s.token_hash) && !Object.values(tokens).includes(s.id)));
  pass('real registration/login, authenticated API and hashed sessions');
  const repo = await request('/api/v1/repos', { token: tokens.owner,
    body: { parent_ref: 'owner', uid: 'private', is_public: false, readme: true } });
  assert.equal(repo.status, 201);
  const repoPath = '/api/v1/repos/owner/private/+';
  const commit = await request(`${repoPath}/commits`, { token: tokens.owner,
    body: { message: 'Large fixture', files: [0, 1, 2].map(i => ({ path: `large${i}.txt`, action: 'create', content: 'x'.repeat(750 * 1024) })) } });
  assert.equal(commit.status, 200, `>2 MiB real git commit: ${commit.json?.message || ''}`);
  assert.equal((await request(`${repoPath}/compare?base=main~1&head=main`, { token: tokens.owner })).status, 200);
  assert.equal((await request(`${repoPath}/commits`, { token: tokens.owner,
    body: { new_branch: 'feature', message: 'Private PR fixture', files: [{ action: 'create', path: 'pr.txt', content: 'private diff fixture' }] } })).status, 200);
  const pr = await request(`${repoPath}/pullreq`, { token: tokens.owner,
    body: { title: 'Private fixture', source_branch: 'feature', target_branch: 'main' } });
  assert.equal(pr.status, 201);
  assert.equal(pr.json.number, 1);
  const privateDiff = await request(`${repoPath}/pullreq/1/diff`, { token: tokens.owner });
  assert.equal(privateDiff.status, 200);
  assert.match(privateDiff.text, /pr\.txt/);
  for (const suffix of ['', '/compare?base=main~1&head=main', '/pullreq', '/pullreq/1', '/pullreq/1/diff', '/commits', '/raw/large0.txt']) {
    assert.equal((await request(repoPath + suffix, { token: tokens.outsider })).status, 404, `private protection ${suffix}`);
  }
  assert.equal((await request(`${repoPath}/compare?base=main~1&head=main`)).status, 401);
  assert.equal((await request(`${repoPath}/pullreq/1/diff`)).status, 401);
  assert.equal((await request('/api/v1/repos', { token: tokens.owner,
    body: { parent_ref: 'owner', uid: 'other', is_public: false } })).status, 201);
  pass('private repo/compare/PR diff/commits/raw authorization and real >1 MiB git commit');
  const bigConversation = { repoPath: 'owner/private', messages: [{ role: 'user', content: 'c'.repeat(2 * 1024 * 1024) }] };
  for (const alias of ['/api/v1', '/api/sync/v1']) {
    assert.equal((await request(`${alias}/conversations`, { token: tokens.owner, body: bigConversation })).status, 201);
  }
  assert.equal((await request('/api/v1/login', { body: { data: 'x'.repeat(32 * 1024) } })).status, 413);
  assert.equal((await request('/api/v1/ai/chat', { body: { data: 'x'.repeat(2 * 1024 * 1024) } })).status, 401);
  pass('large conversation bodies on both API aliases; ordinary 413 and unauthenticated large-body 401');

  const repoRow = (await pool.query("SELECT * FROM repos WHERE space_uid='owner' AND uid='private'")).rows[0];
  async function service(name, image, policy = 1, runtime = {}) {
    const row = (await pool.query(`INSERT INTO deploy_services
      (repo_id,name,created_by,created,updated,container_port,security_policy_version,runtime_options)
      VALUES ($1,$2,'owner',$3,$3,80,$4,$5) RETURNING *`, [repoRow.id, name, Date.now(), policy, runtime])).rows[0];
    const dep = (await pool.query(`INSERT INTO deployments (service_id,status,image_tag,started)
      VALUES ($1,'live',$2,$3) RETURNING *`, [row.id, image, Date.now()])).rows[0];
    await pool.query("UPDATE deploy_services SET current_deployment_id=$1,status='running' WHERE id=$2", [dep.id, row.id]);
    return { ...row, current_deployment_id: dep.id, container: docker.getContainer(containerName(row.id, dep.id)) };
  }
  const legacy = await service('old-network', 'nixre-upgrade-core:test');
  await docker.createVolume({ Name: 'check-app-state' });
  const app = await docker.createContainer({ name: containerName(legacy.id, legacy.current_deployment_id),
    Image: 'nixre-upgrade-core:test', Entrypoint: ['node'], Cmd: ['-e', "require('http').createServer((q,s)=>s.end('fixture')).listen(80,'0.0.0.0')"],
    HostConfig: { Binds: ['check-app-state:/state'], NetworkMode: `${prefix}-old` } });
  await app.start();
  await docker.getNetwork(process.env.NIXRE_DATA_NETWORK).connect({ Container: app.id });
  assert.equal((await exec(app, ['sh', '-c', 'printf writable-layer > /sentinel; printf persistent-volume > /state/sentinel'])).code, 0);
  const before = await app.inspect();
  const dbInfo = await docker.getContainer('check-db').inspect();
  const dbIp = dbInfo.NetworkSettings.Networks[process.env.NIXRE_DATA_NETWORK].IPAddress;
  const tcpProbe = `const s=require('net').connect(5432,${JSON.stringify(dbIp)});s.setTimeout(1500);s.on('connect',()=>{s.destroy();process.exit(0)});s.on('timeout',()=>{s.destroy();process.exit(2)});s.on('error',()=>process.exit(2))`;
  assert.equal((await exec(app, ['node', '-e', tcpProbe])).code, 0, 'positive DB connectivity control on legacy shared network');
  await engine.sweep();
  const after = await app.inspect();
  assert.equal(after.Id, before.Id);
  assert.deepEqual(after.Mounts, before.Mounts);
  assert.deepEqual(Object.keys(after.NetworkSettings.Networks), [process.env.NIXRE_APPS_NETWORK]);
  assert.equal((await exec(app, ['cat', '/sentinel'])).output, 'writable-layer');
  assert.equal((await exec(app, ['cat', '/state/sentinel'])).output, 'persistent-volume');
  assert.equal((await exec(app, ['node', '-e', tcpProbe])).code, 2, 'app cannot reach DB by IP');
  const target = await engine.findServiceTarget(legacy.id);
  assert.equal((await fetch(`http://${target.ip}:${target.port}`)).status, 200);
  pass(`app in-place reconciliation preserves ID ${after.Id}, writable layer and named volume; approved network/HTTP and DB isolation`);

  const domain = `${prefix}.example.test`;
  // Fixture-only verified state: no public DNS calls or domain provisioning.
  await pool.query(`INSERT INTO deploy_domains (service_id,domain,created,verified,verified_at)
    VALUES ($1,$2,$3,true,$3),($1,$4,$3,false,NULL)`, [legacy.id, domain, Date.now(), `unverified.${domain}`]);
  const proxyRequest = (host = domain) => new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port: 3003, path: '/upgrade-check', headers: { host } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body }));
      res.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error('Deploy proxy timed out')));
    req.on('error', reject);
  });
  await eventually(async () => (await proxyRequest()).status === 200, 'live deploy proxy route');
  assert.deepEqual(await proxyRequest(), { status: 200, body: 'fixture' });
  assert.equal((await proxyRequest(`unverified.${domain}`)).status, 404);
  pass(`live :3003 proxy routes verified ${domain} to migrated app; unverified domain is parked`);

  const failingDockerfile = [
    'FROM nixre-upgrade-core:test',
    'ENTRYPOINT ["node"]',
    `CMD ${JSON.stringify(['-e', "require('http').createServer((q,s)=>{s.writeHead(503);s.end('candidate-unhealthy')}).listen(80,'0.0.0.0')"])}`,
    '',
  ].join('\n');
  const candidate = await request(`${repoPath}/commits`, { token: tokens.owner, body: {
    message: 'Unhealthy release fixture', files: [{ action: 'create', path: 'Dockerfile', content: failingDockerfile }],
  } });
  assert.equal(candidate.status, 200);
  const release = await engine.startDeployment(legacy.id, { ref: candidate.json.sha });
  const deadline = Date.now() + 60_000;
  let requestsDuringRelease = 0;
  while (engine.isBusy(legacy.id) && Date.now() < deadline) {
    assert.deepEqual(await proxyRequest(), { status: 200, body: 'fixture' });
    requestsDuringRelease++;
    await sleep(100);
  }
  assert.equal(engine.isBusy(legacy.id), false, 'real image build and release must settle');
  assert.ok(requestsDuringRelease > 0);
  const failed = (await pool.query('SELECT * FROM deployments WHERE id=$1', [release.deploymentId])).rows[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Health check failed:.*HTTP 503/);
  const candidateImage = await docker.getImage(failed.image_tag).inspect();
  assert.ok(candidateImage.Id, 'candidate was a real successfully built image');
  const serving = (await pool.query('SELECT * FROM deploy_services WHERE id=$1', [legacy.id])).rows[0];
  assert.equal(serving.current_deployment_id, legacy.current_deployment_id);
  assert.equal(serving.last_failed_deployment_id, release.deploymentId);
  assert.equal(serving.status, 'running');
  assert.equal((await pool.query('SELECT status FROM deployments WHERE id=$1', [legacy.current_deployment_id])).rows[0].status, 'live');
  await assert.rejects(docker.getContainer(containerName(legacy.id, release.deploymentId)).inspect(), { statusCode: 404 });
  await sleep(2200); // Recheck after the production proxy engine's target cache expires.
  assert.deepEqual(await proxyRequest(), { status: 200, body: 'fixture' });
  assert.equal((await app.inspect()).Id, before.Id);
  assert.equal((await exec(app, ['cat', '/sentinel'])).output, 'writable-layer');
  pass(`real image ${candidateImage.Id} rejected for HTTP 503; release ${release.deploymentId} failed, serving release ${legacy.current_deployment_id}/container preserved, proxy served old app during ${requestsDuringRelease} checks and after failure`);

  const nginx1 = await service('nginx-policy1', 'nginx:stable-alpine');
  const runtime = normalizeRuntimeOptions({ host_config: { cap_add: ['CHOWN', 'SETUID', 'SETGID'] } }, { admin: true });
  const nginx2 = await service('nginx-policy2', 'nginx:stable-alpine', 2, runtime);
  await engine.sweep();
  for (const [svc, policy] of [[nginx1, 1], [nginx2, 2]]) {
    await eventually(async () => {
      engine.invalidateTarget(svc.id);
      const t = await engine.findServiceTarget(svc.id);
      return t && (await fetch(`http://${t.ip}:${t.port}`, { signal: AbortSignal.timeout(1500) })).ok;
    }, `nginx policy ${policy} HTTP`);
    const info = await svc.container.inspect();
    assert.equal(info.State.Running, true);
    if (policy === 1) assert.ok(!info.HostConfig.CapDrop?.length);
    else {
      assert.deepEqual(info.HostConfig.CapDrop, ['ALL']);
      assert.deepEqual(info.HostConfig.CapAdd.slice().sort(), ['CHOWN', 'SETGID', 'SETUID']);
      assert.ok(info.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    }
    pass(`missing-container recreation: stock nginx policy ${policy} serves HTTP (${info.Id})`);
  }

  const sandbox = await import('/app/src/lib/agentSandbox.js');
  assert.ok(await sandbox.isSandboxEnabled());
  await sandbox.startSandboxSweeper();
  const conversationId = 'upgrade-conversation';
  const key = `owner:${conversationId}:owner/private`;
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 20);
  const name = `nixre-sb-${hash}`;
  const volume = `nixre-sb-vol-${hash}`;
  const core = await docker.getContainer((await import('node:os')).hostname()).inspect();
  const repos = core.Mounts.find(m => m.Destination === '/data/repos').Source;
  await docker.createVolume({ Name: volume });
  const oldSandbox = await docker.createContainer({ name, Image: process.env.SANDBOX_IMAGE,
    Labels: { 'nixre.sandbox': 'true', 'nixre.user': 'owner', 'nixre.conversation': conversationId,
      'nixre.repo': 'owner/private', 'nixre.lastActivity': String(Date.now()) },
    HostConfig: { Binds: [`${volume}:/workspace`, `${repos}:/data/repos:ro`], NetworkMode: `${prefix}-old` }, Cmd: ['sleep', 'infinity'] });
  await oldSandbox.start();
  const seed = await exec(oldSandbox, ['bash', '-lc', "set -eu; git config --global --add safe.directory '*'; git clone --quiet /data/repos/owner/private.git /workspace/repo; printf unfinished-work > /workspace/repo/work.txt"]);
  assert.equal(seed.code, 0, seed.output);
  assert.equal((await exec(oldSandbox, ['test', '-e', '/data/repos/owner/other.git/HEAD'])).code, 0, 'legacy mount exposes sibling repo');
  await sandbox.startSandboxSweeper();
  assert.equal((await oldSandbox.inspect()).State.Running, false, 'legacy sandbox quarantined before next command');
  const user = { uid: 'owner', name: "O'Name \"quoted\" $(touch /workspace/INJECTED) `touch /workspace/INJECTED` $HOME\nsecond line",
    email: "o'quote+$dollar@example.test" };
  const args = { userId: 'owner', conversationId, repoPath: 'owner/private', user };
  const first = await sandbox.runCommandInSandbox({ ...args, command: 'cat work.txt; printf "\\n"' });
  assert.equal(first.exitCode, 0);
  assert.match(first.output, /unfinished-work/);
  const current = docker.getContainer(name);
  const upgraded = await current.inspect();
  assert.notEqual(upgraded.Id, oldSandbox.id);
  assert.equal(upgraded.Mounts.find(m => m.Destination === '/workspace').Name, volume);
  assert.equal(upgraded.Mounts.length, 2);
  assert.ok(upgraded.Mounts.some(m => m.Destination === '/data/repos/owner/private.git' && !m.RW));
  assert.equal(upgraded.Config.Labels['nixre.sandbox.policy'], '2');
  assert.equal(upgraded.HostConfig.Privileged, false);
  assert.deepEqual(upgraded.HostConfig.CapDrop, ['ALL']);
  assert.equal((await exec(current, ['test', '!', '-e', '/data/repos/owner/other.git/HEAD'])).code, 0, 'replacement cannot read sibling repo');
  assert.deepEqual(Object.keys(upgraded.NetworkSettings.Networks), [process.env.SANDBOX_NETWORK]);
  assert.equal((await exec(current, ['node', '-e', tcpProbe])).code, 2, 'sandbox cannot reach DB by IP');
  for (const [keyName, value] of [['user.name', user.name], ['user.email', user.email]]) {
    assert.equal((await exec(current, ['git', '-C', '/workspace/repo', 'config', keyName])).output, value + '\n');
  }
  assert.equal((await exec(current, ['test', '!', '-e', '/workspace/INJECTED'])).code, 0);
  const literal = "single' double\" dollar$ backtick` semicolon; pipe| ampersand& slash\\";
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  const cmd = `printf '%s\\n' ${quote(literal)}`;
  assert.equal((await sandbox.runCommandInSandbox({ ...args, command: cmd })).output, `exit code: 0\n${literal}`);
  await current.stop({ t: 2 });
  assert.equal((await sandbox.runCommandInSandbox({ ...args, command: cmd })).output, `exit code: 0\n${literal}`);
  assert.equal((await current.inspect()).Id, upgraded.Id, 'compliant stopped container restarted, not recreated');
  assert.equal((await exec(current, ['cat', '/workspace/repo/work.txt'])).output, 'unfinished-work');
  assert.equal((await exec(current, ['git', '-C', '/workspace/repo', 'config', 'user.name'])).output, user.name + '\n');
  pass(`legacy broad-mount sandbox ${oldSandbox.id} replaced by ${upgraded.Id}; volume/work, narrowed mount, literal identities/commands, restart and DB isolation`);
  await assert.rejects(sandbox.runCommandInSandbox({ ...args, user: { uid: 'outsider' }, command: 'touch /workspace/BAD' }), /matching user/);
  await pool.query("UPDATE users SET blocked=true WHERE uid='owner'");
  await assert.rejects(sandbox.runCommandInSandbox({ ...args, command: 'touch /workspace/BAD' }));
  assert.equal((await current.inspect()).State.Running, false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM tokens WHERE id=$1', [`agent-sbx-${hash}`])).rows[0].n, 0);
  pass('sandbox mismatched identity denied; freshly blocked user stops container and revokes sandbox PAT');
} finally {
  await pool.end();
}
// Persistent shell streams intentionally live for core's lifetime.
process.exit(0);

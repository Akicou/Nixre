// HTTP-level tests for the Actions API and friends (secrets, statuses, PR
// checks + merge gate, badges, stars, archive, file list) and for the
// deployments read gate. A real bare repository backs the git reads.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
const ROOT = await mkdtemp(path.join(tmpdir(), 'nixre-actions-'));
process.env.REPOS_ROOT = path.join(ROOT, 'repos');
process.env.AI_SECRET ||= 'actions-route-test-secret-0123456789abcdef';

const { actionsRoutes, badgeSvg } = await import('../routes/actions.js');
const { pullRequestRoutes } = await import('../routes/pullreq.js');
const { deploymentRoutes } = await import('../routes/deployments.js');
const { decryptSecret } = await import('../lib/ai.js');

let mainSha;
let featureSha;

before(async () => {
  const bare = path.join(process.env.REPOS_ROOT, 'acme', 'web.git');
  const work = path.join(ROOT, 'work');
  await mkdir(bare, { recursive: true });
  await exec('git', ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
  await exec('git', ['init', '--quiet', '--initial-branch=main', work]);
  const g = (...args) => exec('git', ['-C', work, '-c', 'user.name=T', '-c', 'user.email=t@example.test', ...args]);
  await mkdir(path.join(work, 'src'), { recursive: true });
  await mkdir(path.join(work, '.nixre', 'workflows'), { recursive: true });
  await writeFile(path.join(work, 'README.md'), '# web\n');
  await writeFile(path.join(work, 'src', 'app.js'), 'console.log(1)\n');
  await writeFile(path.join(work, '.nixre', 'workflows', 'ci.yml'), 'on: push\njobs:\n  a:\n    steps: [{run: echo}]\n');
  await g('add', '-A');
  await g('commit', '--quiet', '-m', 'init');
  await g('checkout', '--quiet', '-b', 'feature');
  await writeFile(path.join(work, 'src', 'feature.js'), 'export {}\n');
  await g('add', '-A');
  await g('commit', '--quiet', '-m', 'feature');
  await g('push', '--quiet', bare, 'main', 'feature');
  mainSha = (await exec('git', ['-C', bare, 'rev-parse', 'main'])).stdout.trim();
  featureSha = (await exec('git', ['-C', bare, 'rev-parse', 'feature'])).stdout.trim();
});

// --- fixtures ----------------------------------------------------------------------

const USERS = {
  member: { uid: 'member', admin: false },
  outsider: { uid: 'outsider', admin: false },
};

function makePool({ isPublic = true, requireChecks = false, statuses = [] } = {}) {
  const state = { secrets: new Map(), stars: new Set(), statuses: [...statuses], queries: [] };
  const repo = { id: 1, space_uid: 'acme', uid: 'web', is_public: isPublic, default_branch: 'main', require_checks: requireChecks };
  state.pool = {
    async query(sql, params = []) {
      state.queries.push(sql);
      if (/FROM repos WHERE space_uid = \$1 AND uid = \$2/.test(sql)) {
        return { rows: params[0] === 'acme' && params[1] === 'web' ? [{ ...repo }] : [] };
      }
      if (sql.includes('FROM space_members')) return { rows: params.includes('member') ? [{ role: 'member' }] : [] };
      if (sql.includes('INSERT INTO repo_secrets')) {
        state.secrets.set(params[1], params[2]);
        return { rows: [] };
      }
      if (sql.includes('count(*)::int AS n FROM repo_secrets')) return { rows: [{ n: state.secrets.size }] };
      if (sql.includes('SELECT key, updated FROM repo_secrets')) {
        return { rows: [...state.secrets.keys()].map(key => ({ key, updated: 1 })) };
      }
      if (sql.includes('DELETE FROM repo_secrets')) {
        state.secrets.delete(params[1]);
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO repo_stars')) {
        state.stars.add(params[1]);
        return { rows: [] };
      }
      if (sql.includes('DELETE FROM repo_stars')) {
        state.stars.delete(params[1]);
        return { rows: [] };
      }
      if (sql.includes('FROM repo_stars')) return { rows: [{ n: state.stars.size }] };
      if (sql.includes('SELECT * FROM pull_requests WHERE repo_id = $1 AND number = $2')) {
        return { rows: [{ id: 3, repo_id: 1, number: 1, state: 'open', source_branch: 'feature', target_branch: 'main', author_uid: 'member' }] };
      }
      if (sql.includes('FROM commit_statuses')) return { rows: state.statuses };
      if (sql.includes('FROM deploy_services')) return { rows: [{ id: 5, repo_id: 1, name: 'web' }] };
      return { rows: [] };
    },
  };
  return state;
}

function fakeRuntime() {
  const calls = [];
  const run = { id: 10, run_number: 4, workflow_path: '.nixre/workflows/ci.yml', workflow_name: 'CI', event: 'push', ref: 'refs/heads/main', sha: 'a'.repeat(40), actor: 'member', status: 'completed', conclusion: 'success', created: 1 };
  return {
    calls,
    engine: {
      async discover() {
        return [{ path: '.nixre/workflows/ci.yml', workflow: { name: 'CI', on: { push: {}, workflow_dispatch: { inputs: {} } }, jobs: [{ id: 'a', name: 'a' }] } }];
      },
      async dispatch(args) {
        calls.push(['dispatch', args.workflowPath, args.actor]);
        return run;
      },
      async cancel() {
        return false;
      },
      async rerun() {
        return run;
      },
      subscribe: () => () => {},
      isActive: () => false,
    },
    store: {
      async listRuns() {
        return [run];
      },
      async getRunByNumber(repoId, n) {
        return n === 4 ? run : null;
      },
      async listJobs() {
        return [];
      },
      async getJob() {
        return null;
      },
      async latestCompletedRun() {
        return run;
      },
      async listStatuses() {
        return [{ context: 'CI / a (push)', state: 'success', description: '', target_url: '', created: 1, updated: 1 }];
      },
      async setStatus(...args) {
        calls.push(['status', ...args.slice(1, 4)]);
      },
    },
  };
}

async function serve(t, { user = null, pool, runtime = fakeRuntime() }) {
  const app = express();
  app.use(express.json());
  const auth = (required = true) => (req, res, next) => {
    if (user) req.auth = { user };
    else if (required) return res.status(401).json({ message: 'Missing or invalid bearer token' });
    next();
  };
  app.use('/api/v1', actionsRoutes(pool, auth, runtime));
  app.use('/api/v1', pullRequestRoutes(pool, auth));
  app.use('/api/v1', deploymentRoutes(pool, auth));
  app.use((err, _req, res, _next) => res.status(500).json({ message: err.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/repos/acme/web/+`;
  return async (p, { method = 'GET', body } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    return {
      status: res.status,
      headers: res.headers,
      buf,
      json: type.includes('json') ? JSON.parse(buf.toString()) : null,
      text: buf.toString(),
    };
  };
}

// --- tests ---------------------------------------------------------------------------------

test('guests read runs, workflows and badges of public repos; private repos are 404 to guests and outsiders', async t => {
  let req = await serve(t, { pool: makePool().pool });
  assert.equal((await req('/actions/runs')).status, 200);
  assert.equal((await req('/actions/runs')).json.runs[0].number, 4);
  assert.equal((await req('/actions/workflows')).json.workflows[0].name, 'CI');
  const detail = await req('/actions/runs/4');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.can_write, false);
  assert.equal((await req('/actions/runs/99')).status, 404);

  for (const user of [null, USERS.outsider]) {
    req = await serve(t, { user, pool: makePool({ isPublic: false }).pool });
    for (const p of ['/actions/runs', '/actions/workflows', '/actions/runs/4', '/actions/badge.svg', '/files', '/archive/main.zip', `/commits/${mainSha}/status`]) {
      assert.equal((await req(p)).status, 404, `${user?.uid ?? 'guest'} ${p}`);
    }
  }
});

test('writes need membership: guests get 401, outsiders 403, members succeed', async t => {
  const runtime = fakeRuntime();
  const writes = [
    ['/actions/dispatch', { method: 'POST', body: { workflow: '.nixre/workflows/ci.yml' } }],
    ['/actions/runs/4/rerun', { method: 'POST' }],
    ['/actions/secrets', {}],
    ['/actions/secrets/TOKEN', { method: 'PUT', body: { value: 'x' } }],
    [`/statuses/${mainSha}`, { method: 'POST', body: { state: 'success' } }],
  ];
  let req = await serve(t, { pool: makePool().pool, runtime });
  for (const [p, o] of writes) assert.equal((await req(p, o)).status, 401, `guest ${p}`);
  req = await serve(t, { user: USERS.outsider, pool: makePool().pool, runtime });
  for (const [p, o] of writes) assert.equal((await req(p, o)).status, 403, `outsider ${p}`);
  req = await serve(t, { user: USERS.member, pool: makePool().pool, runtime });
  assert.equal((await req('/actions/dispatch', writes[0][1])).status, 201);
  assert.deepEqual(runtime.calls[0], ['dispatch', '.nixre/workflows/ci.yml', 'member']);
});

test('secrets are stored encrypted, listed by name only, and names are validated', async t => {
  const state = makePool();
  const req = await serve(t, { user: USERS.member, pool: state.pool });
  assert.equal((await req('/actions/secrets/DEPLOY_TOKEN', { method: 'PUT', body: { value: 's3cr3t-value' } })).status, 200);
  const stored = state.secrets.get('DEPLOY_TOKEN');
  assert.notEqual(stored, 's3cr3t-value');
  assert.equal(decryptSecret(stored), 's3cr3t-value');
  const list = await req('/actions/secrets');
  assert.deepEqual(list.json.map(s => s.key), ['DEPLOY_TOKEN']);
  assert.doesNotMatch(list.text, /s3cr3t/);
  for (const bad of ['GITHUB_TOKEN', '1BAD', 'has-dash']) {
    assert.equal((await req(`/actions/secrets/${bad}`, { method: 'PUT', body: { value: 'x' } })).status, 400, bad);
  }
  assert.equal((await req('/actions/secrets/EMPTY', { method: 'PUT', body: { value: '' } })).status, 400);
  assert.equal((await req('/actions/secrets/DEPLOY_TOKEN', { method: 'DELETE' })).status, 200);
  assert.equal(state.secrets.size, 0);
});

test('badges are SVG with the latest conclusion', async t => {
  const req = await serve(t, { pool: makePool().pool });
  const res = await req('/actions/badge.svg?workflow=ci.yml');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(res.text, /CI: passing/);
  assert.match(badgeSvg('a<b', 'c&d', '#000'), /a&lt;b: c&amp;d/);
});

test('external CI can post statuses; bad input is rejected', async t => {
  const runtime = fakeRuntime();
  const req = await serve(t, { user: USERS.member, pool: makePool().pool, runtime });
  assert.equal((await req(`/statuses/${mainSha}`, { method: 'POST', body: { state: 'success', context: 'jenkins' } })).status, 201);
  assert.deepEqual(runtime.calls.at(-1), ['status', mainSha, 'jenkins', 'success']);
  assert.equal((await req('/statuses/abc', { method: 'POST', body: { state: 'success' } })).status, 400);
  assert.equal((await req(`/statuses/${mainSha}`, { method: 'POST', body: { state: 'green' } })).status, 400);
  const combined = await req(`/commits/${mainSha}/status`);
  assert.equal(combined.json.state, 'success');
});

test('PR checks report the head commit; with required checks a red or missing status blocks the merge', async t => {
  const req0 = await serve(t, { pool: makePool({ requireChecks: true }).pool });
  const checks = await req0('/pullreq/1/checks');
  assert.equal(checks.json.sha, featureSha);
  assert.equal(checks.json.required, true);

  for (const [statuses, re] of [
    [[], /none have reported/],
    [[{ context: 'CI / a (pull_request)', state: 'pending' }], /still running/],
    [[{ context: 'CI / a (pull_request)', state: 'failure' }], /Required checks failed: CI \/ a/],
  ]) {
    const state = makePool({ requireChecks: true, statuses });
    const req = await serve(t, { user: USERS.member, pool: state.pool });
    const res = await req('/pullreq/1/merge', { method: 'POST', body: {} });
    assert.equal(res.status, 409);
    assert.match(res.json.message, re);
    assert.equal(res.json.code, 'checks_required');
  }
});

test('starring needs a login and reports the new count', async t => {
  let req = await serve(t, { pool: makePool().pool });
  assert.equal((await req('/star', { method: 'PUT' })).status, 401);
  const state = makePool();
  req = await serve(t, { user: USERS.member, pool: state.pool });
  assert.deepEqual((await req('/star', { method: 'PUT' })).json, { starred: true, stars: 1 });
  assert.deepEqual((await req('/star', { method: 'DELETE' })).json, { starred: false, stars: 0 });
});

test('archive downloads a zip of any ref; the file list feeds the file finder', async t => {
  const req = await serve(t, { pool: makePool().pool });
  const zip = await req('/archive/feature.zip');
  assert.equal(zip.status, 200);
  assert.match(zip.headers.get('content-disposition'), /web-feature\.zip/);
  assert.equal(zip.buf.subarray(0, 2).toString(), 'PK');
  assert.ok(zip.buf.includes(Buffer.from('web-feature/src/feature.js')));
  assert.equal((await req('/archive/nope.zip')).status, 404);
  assert.equal((await req('/archive/main.rar')).status, 400);
  assert.equal((await req('/archive/--output=x.zip')).status, 404);

  const files = await req('/files?git_ref=feature');
  assert.deepEqual(files.json.files.sort(), ['.nixre/workflows/ci.yml', 'README.md', 'src/app.js', 'src/feature.js']);
});

test('deployments of a private repo are hidden from signed-in outsiders', async t => {
  let req = await serve(t, { user: USERS.outsider, pool: makePool({ isPublic: false }).pool });
  for (const p of ['/deployments/services', '/deployments/services/5/deployments', '/deployments/services/5/http-logs']) {
    assert.equal((await req(p)).status, 404, p);
  }
  req = await serve(t, { user: USERS.member, pool: makePool({ isPublic: false }).pool });
  assert.equal((await req('/deployments/services')).status, 200);
});

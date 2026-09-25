import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createActionsEngine, statusContext } from './actions.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

// --- fakes -------------------------------------------------------------------------

function memoryStore({ repos = [{ id: 1, space_uid: 'acme', uid: 'web', default_branch: 'main' }], secrets = [], prs = [], services = [] } = {}) {
  const runs = [];
  const jobs = [];
  const statuses = new Map();
  const deployments = new Map();
  let jobSeq = 0;
  return {
    runs,
    jobs,
    statuses,
    deployments,
    async getRepo(id) {
      return repos.find(r => r.id === Number(id)) || null;
    },
    async findRepo(space, uid) {
      return repos.find(r => r.space_uid === space && r.uid === uid) || null;
    },
    async listRepos() {
      return repos;
    },
    async createRun(repoId, f) {
      const n = runs.filter(r => r.repo_id === repoId).length + 1;
      const row = { id: runs.length + 1, repo_id: repoId, run_number: n, status: 'queued', conclusion: null, error: null, started: null, finished: null, inputs: {}, pr_number: null, ...f };
      runs.push(row);
      return { ...row };
    },
    async createJob(runId, f) {
      const row = { id: ++jobSeq, run_id: runId, status: 'queued', conclusion: null, log: '', image: '', started: null, finished: null, ...f };
      jobs.push(row);
      return { ...row };
    },
    async updateRun(id, fields) {
      const row = runs.find(r => r.id === Number(id));
      Object.assign(row, fields);
      return { ...row };
    },
    async updateJob(id, fields) {
      const row = jobs.find(r => r.id === Number(id));
      Object.assign(row, JSON.parse(JSON.stringify(fields)));
      return { ...row };
    },
    async setStatus(repoId, sha, context, state, description) {
      statuses.set(`${sha}|${context}`, { state, description });
    },
    async getSecrets() {
      return secrets;
    },
    async openPrsForBranch(repoId, branch) {
      return prs.filter(p => p.source_branch === branch && p.state === 'open');
    },
    async findService(repoId, name) {
      return services.find(s => s.name === name) || null;
    },
    async getDeployment(id) {
      return deployments.get(id) || null;
    },
    async interruptUnfinished(active) {
      const out = [];
      for (const j of jobs) {
        const run = runs.find(r => r.id === j.run_id);
        if (j.status !== 'completed' && !active.has(run.id)) {
          Object.assign(j, { status: 'completed', conclusion: 'failure' });
          out.push({ ...j, repo_id: run.repo_id, sha: run.sha, workflow_name: run.workflow_name, event: run.event });
        }
      }
      for (const r of runs) if (r.status !== 'completed' && !active.has(r.id)) Object.assign(r, { status: 'completed', conclusion: 'failure' });
      return out;
    },
  };
}

function fakeGit(files) {
  // files: { [sha]: { path: content } }
  return {
    async listDir(space, repo, sha, dir) {
      const tree = files[sha] || {};
      const names = Object.keys(tree).filter(p => p.startsWith(`${dir}/`)).map(p => p.slice(dir.length + 1));
      if (!names.length) throw new Error('not found');
      return names.map(name => ({ type: 'file', name }));
    },
    async readFile(space, repo, sha, path) {
      return files[sha][path];
    },
    async resolveRef(space, repo, ref) {
      if (ref === 'refs/heads/main' || ref === 'refs/heads/feature') return { sha: SHA };
      throw new Error('bad ref');
    },
    async changedFiles() {
      return ['src/index.js'];
    },
  };
}

// The runner "executes" a script by interpreting a few shell idioms, which is
// enough to exercise env, outputs, exit codes and cancellation.
function fakeRunner({ hang = false } = {}) {
  const calls = [];
  const started = [];
  const destroyed = [];
  return {
    calls,
    started,
    destroyed,
    async start(opts) {
      started.push(opts);
      opts.onLog(`Pulling ${opts.image}`);
      return { id: `c${opts.jobId}`, files: { output: '', env: '', path: '' } };
    },
    async exec(handle, { script, env, onLine, signal }) {
      calls.push({ script, env });
      if (hang || script.includes('sleep')) {
        await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
        return 137;
      }
      for (const line of script.split('\n')) {
        const echo = /^echo (.*)$/.exec(line.trim());
        if (echo) {
          const text = echo[1].replace(/\$(\w+)/g, (_, k) => env[k] ?? '');
          const redirect = /^(.*?) >> \$GITHUB_(OUTPUT|ENV|PATH)$/.exec(text) || /^"?(.*?)"? >> (OUTPUT|ENV|PATH)$/.exec(text);
          if (/>> \$GITHUB_/.test(echo[1])) {
            const m = /^"?(.*?)"? >> \$GITHUB_(OUTPUT|ENV|PATH)$/.exec(echo[1]);
            const value = m[1].replace(/\$(\w+)/g, (_, k) => env[k] ?? '');
            handle.files[m[2].toLowerCase()] += `${value}\n`;
          } else if (!redirect) onLine(text);
        }
        const exit = /^exit (\d+)$/.exec(line.trim());
        if (exit) return Number(exit[1]);
      }
      return 0;
    },
    async collectFiles(handle) {
      const out = { ...handle.files };
      handle.files = { output: '', env: '', path: '' };
      return out;
    },
    async destroy(handle) {
      destroyed.push(handle.id);
    },
  };
}

function engineWith({ workflows, store = memoryStore(), runner = fakeRunner(), deploy, concurrency = 2 }) {
  const engine = createActionsEngine({
    store,
    git: fakeGit({ [SHA]: workflows, [SHA2]: workflows }),
    runner,
    deploy,
    concurrency,
    logFlushMs: 5,
    deployPollMs: 1,
    serverUrl: 'https://forge.test',
  });
  return { engine, store, runner };
}

const push = (engine, extra = {}) =>
  engine.onPush({ space: 'acme', repo: 'web', ref: 'refs/heads/main', before: SHA2, after: SHA, pusher: 'Lyan', ...extra });

// --- tests -------------------------------------------------------------------------------

test('a push runs matrix jobs in dependency order, passes outputs and env, and reports green statuses', async () => {
  const { engine, store, runner } = engineWith({
    workflows: {
      '.nixre/workflows/ci.yml': `
name: CI
on: push
env:
  STAGE: ci
jobs:
  build:
    runs-on: ubuntu-latest
    outputs:
      version: \${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: echo "version=1.2.3" >> $GITHUB_OUTPUT
      - run: echo "FROM_ENV=yes" >> $GITHUB_ENV
      - run: echo $FROM_ENV $STAGE
  test:
    needs: build
    strategy:
      matrix:
        node: [20, 22]
    container: node:\${{ matrix.node }}
    steps:
      - run: echo testing \${{ needs.build.outputs.version }} on \${{ matrix.node }}
`,
    },
  });
  const runs = await push(engine);
  assert.equal(runs.length, 1);
  await engine.waitIdle();

  const run = store.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'push');
  assert.equal(run.actor, 'Lyan');
  assert.deepEqual(store.jobs.map(j => [j.name, j.conclusion]), [
    ['build', 'success'],
    ['test (20)', 'success'],
    ['test (22)', 'success'],
  ]);
  // Matrix values reach the container image.
  assert.deepEqual(runner.started.map(s => s.image), ['node:22-bookworm', 'node:20', 'node:22']);
  // $GITHUB_ENV from one step reaches the next; workflow env is set.
  assert.match(store.jobs[0].log, /yes ci/);
  // Job outputs flow to dependants.
  assert.match(store.jobs[1].log, /testing 1\.2\.3 on 20/);
  // Standard env is present.
  assert.equal(runner.calls[0].env.GITHUB_SHA, SHA);
  assert.equal(runner.calls[0].env.GITHUB_REF_NAME, 'main');
  assert.equal(runner.calls[0].env.CI, 'true');
  // Every job has a green commit status, and containers are cleaned up.
  const ctx = statusContext(run, 'test (22)');
  assert.deepEqual(store.statuses.get(`${SHA}|${ctx}`).state, 'success');
  assert.equal(runner.destroyed.length, 3);
});

test('a failing step fails the job, skips dependants, still runs if: failure() steps, and masks secrets', async () => {
  const store = memoryStore({ secrets: [{ key: 'TOKEN', value_enc: 'hunter22' }] });
  const { engine } = engineWith({
    store,
    workflows: {
      '.nixre/workflows/ci.yml': `
on: push
jobs:
  test:
    steps:
      - run: echo token is \${{ secrets.TOKEN }}
      - run: exit 3
      - run: echo never
      - if: failure()
        run: echo cleanup after failure
  deploy:
    needs: test
    steps:
      - run: echo deploying
`,
    },
  });
  await push(engine);
  await engine.waitIdle();
  const [test, deploy] = store.jobs;
  assert.equal(test.conclusion, 'failure');
  assert.deepEqual(test.steps.map(s => s.conclusion), ['success', 'failure', 'skipped', 'success']);
  assert.match(test.log, /token is \*\*\*/);
  assert.doesNotMatch(test.log, /hunter22/);
  assert.match(test.log, /Process exited with code 3/);
  assert.match(test.log, /cleanup after failure/);
  assert.equal(deploy.conclusion, 'skipped');
  assert.equal(store.runs[0].conclusion, 'failure');
  const status = store.statuses.get(`${SHA}|${statusContext(store.runs[0], 'test')}`);
  assert.equal(status.state, 'failure');
  assert.match(status.description, /exit 3/);
});

test('continue-on-error keeps the job green', async () => {
  const { engine, store } = engineWith({
    workflows: { '.nixre/workflows/a.yml': 'on: push\njobs:\n  a:\n    steps:\n      - run: exit 1\n        continue-on-error: true\n      - run: echo fine' },
  });
  await push(engine);
  await engine.waitIdle();
  assert.equal(store.jobs[0].conclusion, 'success');
  assert.equal(store.runs[0].conclusion, 'success');
});

test('branch filters decide which workflows run; invalid files are reported as failed runs', async () => {
  const { engine, store } = engineWith({
    workflows: {
      '.nixre/workflows/main-only.yml': "on:\n  push:\n    branches: [release]\njobs:\n  a:\n    steps: [{run: echo}]",
      '.nixre/workflows/broken.yml': 'on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-python@v5',
    },
  });
  const runs = await push(engine);
  await engine.waitIdle();
  assert.equal(runs.length, 1);
  assert.equal(store.runs[0].workflow_path, '.nixre/workflows/broken.yml');
  assert.equal(store.runs[0].conclusion, 'failure');
  assert.match(store.runs[0].error, /Invalid workflow file: .*setup-python/);
  assert.equal([...store.statuses.values()][0].state, 'error');
});

test('.gitea/workflows and .github/workflows are fallbacks; .nixre wins when present', async () => {
  const wf = 'on: push\njobs:\n  a:\n    steps: [{run: echo}]';
  let { engine, store } = engineWith({ workflows: { '.github/workflows/gh.yml': wf, '.gitea/workflows/gt.yml': wf } });
  await push(engine);
  await engine.waitIdle();
  assert.deepEqual(store.runs.map(r => r.workflow_path), ['.gitea/workflows/gt.yml']);
  ({ engine, store } = engineWith({ workflows: { '.github/workflows/gh.yml': wf, '.nixre/workflows/nx.yml': wf } }));
  await push(engine);
  await engine.waitIdle();
  assert.deepEqual(store.runs.map(r => r.workflow_path), ['.nixre/workflows/nx.yml']);
});

test('branch deletions do nothing; a push to a PR branch also runs pull_request workflows', async () => {
  const store = memoryStore({ prs: [{ number: 7, source_branch: 'feature', target_branch: 'main', state: 'open', author_uid: 'bob', title: 'Feat' }] });
  const { engine } = engineWith({
    store,
    workflows: { '.nixre/workflows/pr.yml': 'on:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n    steps:\n      - run: echo pr \${{ github.event.pull_request.number }} \${{ github.head_ref }}' },
  });
  assert.deepEqual(await push(engine, { after: '0'.repeat(40) }), []);
  await push(engine, { ref: 'refs/heads/feature' });
  await engine.waitIdle();
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].event, 'pull_request');
  assert.equal(store.runs[0].pr_number, 7);
  assert.equal(store.runs[0].ref, 'refs/pull/7/head');
  assert.match(store.jobs[0].log, /pr 7 feature/);
});

test('workflow_dispatch validates inputs and exposes them', async () => {
  const { engine, store } = engineWith({
    workflows: {
      '.nixre/workflows/release.yml': `
on:
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [patch, minor]
        required: true
      dry:
        type: boolean
        default: false
jobs:
  go:
    steps:
      - run: echo level=\${{ inputs.level }} dry=\${{ inputs.dry }}
`,
    },
  });
  const repoRow = await store.getRepo(1);
  await assert.rejects(
    engine.dispatch({ repoRow, workflowPath: '.nixre/workflows/release.yml', inputs: { level: 'major' }, actor: 'Lyan' }),
    /must be one of: patch, minor/,
  );
  await assert.rejects(engine.dispatch({ repoRow, workflowPath: '.nixre/workflows/nope.yml', actor: 'Lyan' }), /not found/);
  await engine.dispatch({ repoRow, workflowPath: '.nixre/workflows/release.yml', inputs: { level: 'minor' }, actor: 'Lyan' });
  await engine.waitIdle();
  assert.equal(store.runs[0].event, 'workflow_dispatch');
  assert.equal(store.runs[0].ref, 'refs/heads/main');
  assert.match(store.jobs[0].log, /level=minor dry=false/);
});

test('schedules fire once per matching minute on the default branch', async () => {
  const { engine, store } = engineWith({
    workflows: { '.nixre/workflows/nightly.yml': "on:\n  schedule:\n    - cron: '30 2 * * *'\njobs:\n  a:\n    steps: [{run: echo nightly}]" },
  });
  assert.equal((await engine.scheduleTick(new Date('2026-09-25T02:29:00Z'))).length, 0);
  assert.equal((await engine.scheduleTick(new Date('2026-09-25T02:30:00Z'))).length, 1);
  assert.equal((await engine.scheduleTick(new Date('2026-09-25T02:30:30Z'))).length, 0, 'same minute');
  await engine.waitIdle();
  assert.equal(store.runs[0].event, 'schedule');
  assert.equal(store.runs[0].actor, 'schedule');
});

test('cancelling a run stops running jobs and cancels queued ones', async () => {
  const { engine, store, runner } = engineWith({
    concurrency: 1,
    workflows: { '.nixre/workflows/slow.yml': 'on: push\njobs:\n  a:\n    steps: [{run: sleep 100}]\n  b:\n    steps: [{run: echo b}]' },
  });
  const [run] = await push(engine);
  while (runner.calls.length === 0) await new Promise(r => setTimeout(r, 2));
  assert.equal(await engine.cancel(run.id), true);
  await engine.waitIdle();
  assert.equal(store.runs[0].conclusion, 'cancelled');
  assert.deepEqual(store.jobs.map(j => j.conclusion), ['cancelled', 'cancelled']);
  assert.equal(runner.calls.length, 1, 'the queued job never started');
});

test('nixre/deploy releases the named service at the run commit and waits for it', async () => {
  const store = memoryStore({ services: [{ id: 9, name: 'web' }] });
  const started = [];
  const deploy = {
    async start(serviceId, opts) {
      started.push([serviceId, opts]);
      store.deployments.set(55, { id: 55, status: 'building' });
      setTimeout(() => store.deployments.set(55, { id: 55, status: 'live' }), 5);
      return { deploymentId: 55 };
    },
    subscribe(serviceId, fn) {
      fn({ type: 'log', line: 'Step 1/3 : FROM node' });
      return () => {};
    },
  };
  const { engine } = engineWith({
    store,
    deploy,
    workflows: { '.nixre/workflows/cd.yml': 'on: push\njobs:\n  ship:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: nixre/deploy@v1\n        with:\n          service: web' },
  });
  await push(engine);
  await engine.waitIdle();
  assert.deepEqual(started, [[9, { ref: SHA, trigger: 'workflow' }]]);
  assert.equal(store.jobs[0].conclusion, 'success');
  assert.match(store.jobs[0].log, /\[deploy\] Step 1\/3/);
  assert.match(store.jobs[0].log, /Deployment #55 is live/);
});

test('rerun creates a new run for the same commit; sweep closes runs left by a restart', async () => {
  const { engine, store } = engineWith({ workflows: { '.nixre/workflows/a.yml': 'on: push\njobs:\n  a:\n    steps: [{run: echo hi}]' } });
  await push(engine);
  await engine.waitIdle();
  await engine.rerun(store.runs[0], 'bob');
  await engine.waitIdle();
  assert.equal(store.runs.length, 2);
  assert.equal(store.runs[1].run_number, 2);
  assert.equal(store.runs[1].sha, SHA);
  assert.equal(store.runs[1].actor, 'bob');

  // A leftover unfinished run from "another process".
  store.runs.push({ id: 99, repo_id: 1, run_number: 3, status: 'running', sha: SHA, workflow_name: 'X', event: 'push' });
  store.jobs.push({ id: 500, run_id: 99, name: 'x', status: 'running' });
  assert.equal(await engine.sweep(), 1);
  assert.equal(store.runs.find(r => r.id === 99).conclusion, 'failure');
  assert.equal(store.statuses.get(`${SHA}|X / x (push)`).state, 'error');
});

test('live events are replayed to late subscribers', async () => {
  const { engine } = engineWith({ workflows: { '.nixre/workflows/a.yml': 'on: push\njobs:\n  a:\n    steps: [{run: echo streamed}]' } });
  const [run] = await push(engine);
  await engine.waitIdle();
  const seen = [];
  const off = engine.subscribe(run.id, e => seen.push(e));
  off();
  assert.ok(seen.some(e => e.type === 'log' && e.line === 'streamed'));
  assert.ok(seen.some(e => e.type === 'run' && e.conclusion === 'success'));
  assert.equal(seen.at(-1).type, 'end');
});

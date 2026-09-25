import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWorkflow,
  matchesEvent,
  expandMatrix,
  matrixJobName,
  cronMatches,
  parseCron,
  evaluate,
  evaluateIf,
  interpolate,
  parseKeyValueFile,
  imageFor,
  globToRegExp,
  matchPatterns,
  jobOrder,
  WorkflowError,
} from './workflowSpec.js';

const CI = `
name: CI
on:
  push:
    branches: [main, 'release/**']
    paths-ignore: ['docs/**']
  pull_request:
    branches: [main]
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high]
        default: low
  schedule:
    - cron: '0 3 * * 1-5'
env:
  GREETING: hi
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  deploy:
    needs: test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: nixre/deploy@v1
        with:
          service: web
`;

test('parses a realistic workflow into a normalized shape', () => {
  const wf = parseWorkflow(CI, '.nixre/workflows/ci.yml');
  assert.equal(wf.name, 'CI');
  assert.deepEqual(Object.keys(wf.on).sort(), ['pull_request', 'push', 'schedule', 'workflow_dispatch']);
  assert.deepEqual(wf.on.schedule, ['0 3 * * 1-5']);
  assert.equal(wf.on.workflow_dispatch.inputs.level.default, 'low');
  assert.equal(wf.env.GREETING, 'hi');
  assert.equal(wf.jobs.length, 2);
  assert.equal(wf.jobs[0].steps[0].action, 'checkout');
  assert.equal(wf.jobs[1].steps[0].action, 'deploy');
  assert.equal(wf.jobs[1].steps[0].with.service, 'web');
  assert.deepEqual(wf.jobs[1].needs, ['test']);
});

test('the workflow name defaults to the file name, and on: accepts a string or a list', () => {
  assert.equal(parseWorkflow('on: push\njobs:\n  a:\n    steps:\n      - run: echo', 'x/build.yml').name, 'build.yml');
  const wf = parseWorkflow('on: [push, workflow_dispatch]\njobs:\n  a:\n    steps:\n      - run: echo');
  assert.deepEqual(Object.keys(wf.on), ['push', 'workflow_dispatch']);
});

test('rejects what Nixre cannot run, with a message the repo owner can act on', () => {
  const bad = [
    ['on: push\njobs: {}', /jobs/],
    ['jobs:\n  a:\n    steps:\n      - run: x', /on:/],
    ['on: release\njobs:\n  a:\n    steps:\n      - run: x', /Unsupported event 'release'/],
    ['on: push\njobs:\n  a:\n    steps:\n      - uses: actions/setup-node@v4', /actions\/setup-node@v4' is not available/],
    ['on: push\njobs:\n  a:\n    needs: b\n    steps:\n      - run: x', /unknown job 'b'/],
    ['on: push\njobs:\n  a:\n    needs: b\n    steps: [{run: x}]\n  b:\n    needs: a\n    steps: [{run: x}]', /cycle/],
    ['on: push\njobs:\n  a:\n    steps:\n      - run: x\n        uses: y', /exactly one/],
    ['on:\n  schedule:\n    - cron: "61 * * * *"\njobs:\n  a:\n    steps: [{run: x}]', /out of range/],
    ['on: push\njobs:\n  a:\n    steps:\n      - uses: nixre/deploy@v1', /service/],
    ['on: push\njobs:\n  a:\n    services:\n      db: {image: postgres}\n    steps: [{run: x}]', /services/],
    ['on: [push\n', /YAML error/],
  ];
  for (const [src, re] of bad) {
    assert.throws(() => parseWorkflow(src), err => err instanceof WorkflowError && re.test(err.message), src);
  }
});

test('push matching: branch, tag and path filters follow GitHub rules', () => {
  const wf = parseWorkflow(CI);
  assert.equal(matchesEvent(wf, { name: 'push', ref: 'refs/heads/main', changedFiles: ['src/a.js'] }), true);
  assert.equal(matchesEvent(wf, { name: 'push', ref: 'refs/heads/release/1.2', changedFiles: null }), true);
  assert.equal(matchesEvent(wf, { name: 'push', ref: 'refs/heads/feature', changedFiles: ['a'] }), false);
  // Only docs changed: ignored.
  assert.equal(matchesEvent(wf, { name: 'push', ref: 'refs/heads/main', changedFiles: ['docs/x.md'] }), false);
  // Branch filters only: a tag push does not trigger.
  assert.equal(matchesEvent(wf, { name: 'push', ref: 'refs/tags/v1' }), false);

  const tags = parseWorkflow("on:\n  push:\n    tags: ['v*']\njobs:\n  a:\n    steps: [{run: x}]");
  assert.equal(matchesEvent(tags, { name: 'push', ref: 'refs/tags/v1.0' }), true);
  assert.equal(matchesEvent(tags, { name: 'push', ref: 'refs/tags/nightly' }), false);
  assert.equal(matchesEvent(tags, { name: 'push', ref: 'refs/heads/main' }), false);

  const any = parseWorkflow('on: push\njobs:\n  a:\n    steps: [{run: x}]');
  assert.equal(matchesEvent(any, { name: 'push', ref: 'refs/heads/whatever' }), true);
  assert.equal(matchesEvent(any, { name: 'push', ref: 'refs/tags/v2' }), true);
  assert.equal(matchesEvent(any, { name: 'pull_request', action: 'opened', baseBranch: 'main' }), false);
});

test('pull_request matching uses the base branch and default activity types', () => {
  const wf = parseWorkflow(CI);
  assert.equal(matchesEvent(wf, { name: 'pull_request', action: 'opened', baseBranch: 'main' }), true);
  assert.equal(matchesEvent(wf, { name: 'pull_request', action: 'synchronize', baseBranch: 'main' }), true);
  assert.equal(matchesEvent(wf, { name: 'pull_request', action: 'closed', baseBranch: 'main' }), false);
  assert.equal(matchesEvent(wf, { name: 'pull_request', action: 'opened', baseBranch: 'dev' }), false);
});

test('glob patterns: * stays in a segment, ** crosses, ! negates (last match wins)', () => {
  assert.equal(globToRegExp('feature/*').test('feature/x'), true);
  assert.equal(globToRegExp('feature/*').test('feature/x/y'), false);
  assert.equal(globToRegExp('feature/**').test('feature/x/y'), true);
  assert.equal(globToRegExp('**.js').test('a/b/c.js'), true);
  assert.equal(globToRegExp('**/*.md').test('README.md'), true);
  assert.equal(matchPatterns('release/beta', ['release/**', '!release/beta']), false);
  assert.equal(matchPatterns('release/1', ['release/**', '!release/beta']), true);
});

test('matrix expansion: product, exclude, include extending and adding jobs', () => {
  assert.deepEqual(expandMatrix(null), [{}]);
  const m = expandMatrix({
    os: ['linux', 'mac'],
    node: [20, 22],
    exclude: [{ os: 'mac', node: 20 }],
    include: [{ node: 22, experimental: true }, { os: 'windows', node: 22 }],
  });
  assert.deepEqual(m, [
    { os: 'linux', node: 20 },
    { os: 'linux', node: 22, experimental: true },
    { os: 'mac', node: 22, experimental: true },
    { os: 'windows', node: 22 },
  ]);
  assert.deepEqual(expandMatrix({ include: [{ a: 1 }, { a: 2 }] }), [{ a: 1 }, { a: 2 }]);
  assert.equal(matrixJobName('test', { node: 20, os: 'linux' }), 'test (20, linux)');
  assert.equal(matrixJobName('test', {}), 'test');
  assert.throws(() => expandMatrix({ a: Array.from({ length: 9 }, (_, i) => i), b: Array.from({ length: 9 }, (_, i) => i) }), /max 64/);
});

test('cron: ranges, steps, names and the day-of-month/day-of-week OR rule, in UTC', () => {
  const at = s => new Date(s);
  assert.equal(cronMatches('0 3 * * 1-5', at('2026-09-25T03:00:00Z')), true); // Friday
  assert.equal(cronMatches('0 3 * * 1-5', at('2026-09-26T03:00:00Z')), false); // Saturday
  assert.equal(cronMatches('*/15 * * * *', at('2026-09-25T10:45:00Z')), true);
  assert.equal(cronMatches('*/15 * * * *', at('2026-09-25T10:46:00Z')), false);
  assert.equal(cronMatches('0 0 1 jan *', at('2026-01-01T00:00:00Z')), true);
  assert.equal(cronMatches('0 0 * * sun', at('2026-09-27T00:00:00Z')), true);
  assert.equal(cronMatches('0 0 * * 7', at('2026-09-27T00:00:00Z')), true);
  // 13th OR Friday.
  assert.equal(cronMatches('0 0 13 * 5', at('2026-09-25T00:00:00Z')), true);
  assert.throws(() => parseCron('* * *'), /5 fields/);
});

test('expressions: contexts, operators, functions and loose equality', () => {
  const ctx = {
    github: { ref: 'refs/heads/main', event_name: 'push', actor: 'Lyan' },
    matrix: { node: 22 },
    env: { MODE: 'Prod' },
    steps: { build: { outputs: { version: '1.2.3' } } },
    needs: { test: { result: 'success', outputs: { url: 'x' } } },
  };
  assert.equal(evaluate("github.ref == 'refs/heads/main'", ctx), true);
  assert.equal(evaluate("env.MODE == 'prod'", ctx), true); // case-insensitive
  assert.equal(evaluate('matrix.node >= 20 && matrix.node < 23', ctx), true);
  assert.equal(evaluate("startsWith(github.ref, 'refs/heads/')", ctx), true);
  assert.equal(evaluate("contains(fromJSON('[\"a\",\"b\"]'), 'b')", ctx), true);
  assert.equal(evaluate("format('v{0}-{1}', steps.build.outputs.version, matrix.node)", ctx), 'v1.2.3-22');
  assert.equal(evaluate("needs.test.result == 'success' || false", ctx), true);
  assert.equal(evaluate('!github.missing', ctx), true);
  assert.equal(evaluate("github['actor']", ctx), 'Lyan');
  assert.equal(evaluate("'it''s'", ctx), "it's");
  assert.equal(interpolate('node ${{ matrix.node }} by ${{ github.actor }}', ctx), 'node 22 by Lyan');
  assert.throws(() => evaluate('nope(', ctx), WorkflowError);
});

test('if: conditions are implicitly gated on success() unless they use a status function', () => {
  const ctx = { github: { ref: 'refs/heads/main' } };
  assert.equal(evaluateIf(null, { ...ctx, status: 'success' }), true);
  assert.equal(evaluateIf(null, { ...ctx, status: 'failure' }), false);
  assert.equal(evaluateIf("github.ref == 'refs/heads/main'", { ...ctx, status: 'failure' }), false);
  assert.equal(evaluateIf('${{ always() }}', { ...ctx, status: 'failure' }), true);
  assert.equal(evaluateIf('failure()', { ...ctx, status: 'failure' }), true);
  assert.equal(evaluateIf('failure()', { ...ctx, status: 'success' }), false);
});

test('GITHUB_ENV / GITHUB_OUTPUT files: simple lines and heredocs', () => {
  assert.deepEqual(parseKeyValueFile('A=1\nB=x=y\n\nNOTES<<EOF\nline 1\nline 2\nEOF\nC=3'), {
    A: '1',
    B: 'x=y',
    NOTES: 'line 1\nline 2',
    C: '3',
  });
});

test('runs-on labels map to images; container.image wins; unknown labels are rejected', () => {
  const opts = { defaultImage: 'node:22-bookworm', sandboxImage: 'nixre-agent-sandbox:latest' };
  assert.equal(imageFor({ runsOn: 'ubuntu-latest' }, opts), 'node:22-bookworm');
  assert.equal(imageFor({ runsOn: 'ubuntu-22.04' }, opts), 'node:22-bookworm');
  assert.equal(imageFor({ runsOn: 'nixre-sandbox' }, opts), 'nixre-agent-sandbox:latest');
  assert.equal(imageFor({ runsOn: 'python:3.12-slim' }, opts), 'python:3.12-slim');
  assert.equal(imageFor({ runsOn: 'ubuntu-latest', container: { image: 'rust:1' } }, opts), 'rust:1');
  assert.throws(() => imageFor({ runsOn: 'windows latest!' }, opts), /not a known label/);
});

test('jobOrder returns dependencies first', () => {
  const order = jobOrder([
    { id: 'deploy', needs: ['build', 'test'] },
    { id: 'test', needs: ['build'] },
    { id: 'build', needs: [] },
  ]);
  assert.deepEqual(order, ['build', 'test', 'deploy']);
});

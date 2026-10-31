import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSecurityScan } from './securityScanRun.js';

// A just-enough fake of pg: routes by SQL text and records issue writes.
function fakePool() {
  const log = { issues: [], scans: [] };
  const pool = {
    log,
    async query(sql, params = []) {
      if (/INSERT INTO security_scans/.test(sql)) return { rows: [{ id: 1 }] };
      if (/UPDATE security_scans/.test(sql)) { log.scans.push(params); return { rows: [] }; }
      if (/FROM security_scans WHERE status = 'ok'/.test(sql)) return { rows: [] };
      if (/FROM instance_settings/.test(sql)) return { rows: [] };
      if (/FROM repos WHERE space_uid/.test(sql)) return { rows: [{ id: 7, space_uid: params[0], uid: params[1] }] };
      if (/FROM issues WHERE repo_id/.test(sql)) return { rows: [] };
      if (/UPDATE issues SET updated/.test(sql)) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    },
    async connect() {
      return {
        async query(sql, params) {
          if (/max\(number\)/.test(sql)) return { rows: [{ n: 1 }] };
          if (/INSERT INTO issues/.test(sql)) { pool.log.issues.push(params); return { rows: [{ number: 1 }] }; }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  return pool;
}

const data = {
  targets: [{ id: 'acme/web:app', container: 'c1', repo: 'acme/web', domains: ['web.example'] }],
  inv: [{ target: 'acme/web:app', repo: 'acme/web', domains: ['web.example'], runtime: ['node v22.23.2'], packages: 3 }],
  findings: [{ target: 'acme/web:app', kind: 'npm', package: 'x', version: '1.0.0', ids: ['GHSA-1'] }],
  details: { 'GHSA-1': { id: 'GHSA-1', severity: 'HIGH', fixed: ['1.0.1'] } },
};

// Scripted model: round 1 asks for two tool calls, round 2 writes the report.
function scriptedModel(calls) {
  let round = 0;
  return async (_opts, send) => {
    if (round++ === 0) {
      calls.forEach((c, i) => send({ type: 'tool_delta', index: i, id: `t${i}`, name: c.name, argsDelta: JSON.stringify(c.args) }));
      await send({ type: 'finish', reason: 'tool_calls' });
    } else {
      await send({ type: 'text', text: 'Report: fix filed.' });
      await send({ type: 'finish', reason: 'stop' });
    }
  };
}

const ai = { userUid: 'admin', provider: 'custom', apiKey: null, baseUrl: 'http://x', model: 'm' };

test('scan files an issue in an in-scope repo and refuses out-of-scope repos', async () => {
  const pool = fakePool();
  const out = await runSecurityScan({
    pool, trigger: 'manual', force: true,
    deps: {
      docker: {}, ai, collect: async () => data,
      streamChat: scriptedModel([
        { name: 'create_issue', args: { repo: 'victim/private', key: 'k', title: 'pwn', body: 'b' } },
        { name: 'create_issue', args: { repo: 'acme/web', key: 'GHSA-1:x', title: 'Bump x', body: 'Upgrade x to 1.0.1' } },
        { name: 'exec_in_container', args: { target: 'acme/web:app', argv: ['sh', '-c', 'id'] } },
      ]),
    },
  });
  assert.equal(out.status, 'ok');
  assert.equal(pool.log.issues.length, 1);
  assert.equal(pool.log.issues[0][0], 7);              // repo id of acme/web
  assert.equal(pool.log.issues[0][5], 'admin');        // authored as the configured admin
  const [, , status, summary, , findings, issues, , report] = pool.log.scans.at(-1);
  assert.equal(status, 'ok');
  assert.equal(findings, 1);
  assert.equal(issues, 1);
  assert.match(summary, /1 issue\(s\) filed/);
  assert.match(JSON.parse(report).markdown, /Report: fix filed\./);
});

test('without an assistant provider the scan reports but files nothing', async () => {
  const pool = fakePool();
  pool.query = new Proxy(pool.query, {}); // keep fake; provider lookup returns no rows below
  const orig = pool.query.bind(pool);
  pool.query = async (sql, params) => (/FROM ai_providers p/.test(sql) ? { rows: [] } : orig(sql, params));
  const out = await runSecurityScan({ pool, trigger: 'manual', force: true, deps: { docker: {}, collect: async () => data } });
  assert.equal(out.status, 'ok');
  assert.equal(pool.log.issues.length, 0);
  assert.match(pool.log.scans.at(-1)[3], /No assistant provider/);
});

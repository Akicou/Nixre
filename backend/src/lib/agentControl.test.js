import { test } from 'node:test';
import assert from 'node:assert/strict';
import { taskController, emptyTaskState, validateSettings, assertBudget, recoverThread, mutateTaskState, readTaskState } from './agentControl.js';

function pool() {
  const states = new Map();
  return { states, async query(sql, params) {
    if (sql.startsWith('SELECT state')) return { rows: states.has(params[0]) ? [{ state: structuredClone(states.get(params[0])) }] : [] };
    if (sql.startsWith('INSERT INTO agent_task_state')) { states.set(params[0], JSON.parse(params[1])); return { rows: [] }; }
    throw new Error('Unexpected SQL');
  } };
}
const ctx = { conversationId: 'c', userId: 'u', repoPath: 'a/b' };

test('settings reject invalid limits and require configured prices for spending limits', () => {
  assert.throws(() => validateSettings({ preset: 'unrestricted' }));
  assert.throws(() => validateSettings({ maxTokens: NaN }));
  assert.throws(() => validateSettings({ maxSeconds: -1 }));
  assert.throws(() => validateSettings({ maxCost: 1 }));
  assert.equal(validateSettings({ maxCost: 1, inputPrice: 1, outputPrice: 2 }).maxCost, 1);
});
test('usage accumulates with configured pricing and enforces token/cost budgets', async () => {
  const db = pool(), c = taskController(db, ctx);
  await c.action({ type: 'settings', settings: { maxTokens: 1000, maxCost: 0.001, inputPrice: 1, outputPrice: 2 } });
  await c.usage({ input: 500, output: 300 });
  const state = await c.read();
  assert.equal(state.usage.estimatedCost, 0.0011);
  assert.throws(() => assertBudget(state), /spending/);
  state.settings.maxCost = 0; state.usage.output = 501;
  assert.throws(() => assertBudget(state), /token/);
});
test('concurrent state updates do not overwrite one another', async () => {
  const db = pool();
  await Promise.all(Array.from({ length: 20 }, () => mutateTaskState(db, 'c', s => { s.usage.input++; })));
  assert.equal((await readTaskState(db, 'c')).usage.input, 20);
});
test('write proposals never execute writes until accepted and stale content is rejected', async () => {
  let content = 'before'; const operations = [];
  const db = pool(), c = taskController(db, ctx, { operation: async (_ctx, op) => {
    operations.push(op.op);
    if (op.op === 'read') return { content };
    if (op.op === 'apply') { assert.equal(op.before, content, 'stale'); content = op.content; return { checkpoint: { id: 'cp', files: 1 } }; }
  } });
  await c.action({ type: 'settings', settings: { autoVerify: false } });
  await c.execute('write_file', { path: 'a.js', content: 'after' }, { callId: 'w' }, () => assert.fail('raw write called'));
  assert.equal(content, 'before'); assert.deepEqual(operations, ['read']);
  const proposal = (await c.read()).proposals[0];
  await c.action({ type: 'proposal', id: proposal.id, accept: true });
  assert.equal(content, 'after'); assert.equal((await c.read()).checkpoints.length, 1);
  await assert.rejects(c.action({ type: 'proposal', id: proposal.id, accept: true }), /not pending/);
});
test('read-only and restricted presets block arbitrary commands without calling executors', async () => {
  for (const preset of ['read_only', 'restricted']) {
    const c = taskController(pool(), ctx);
    await c.action({ type: 'settings', settings: { preset } });
    await assert.rejects(c.execute('run_command', { command: 'echo hi' }, {}, () => assert.fail()), /does not allow/);
  }
});
test('command approval is one-time and bound to its conversation', async () => {
  const db = pool(), c = taskController(db, ctx);
  let executions = 0;
  const pending = c.execute('run_command', { command: 'npm test' }, { callId: 'cmd' }, async () => { executions++; return 'ok'; });
  let approval;
  for (let i = 0; i < 30; i++) { await new Promise(r => setImmediate(r)); approval = (await c.read()).approvals[0]; if (approval) break; }
  assert.ok(approval); assert.equal(executions, 0);
  await assert.rejects(taskController(db, { ...ctx, conversationId: 'other' }).action({ type: 'approval', id: approval.id, accept: true }), /no longer active/);
  await c.action({ type: 'approval', id: approval.id, accept: true });
  assert.equal(await pending, 'ok'); assert.equal(executions, 1);
  assert.equal(await c.execute('run_command', { command: 'npm test' }, { callId: 'cmd' }, () => assert.fail('duplicate')), 'ok');
});
test('cancelled approval cannot leave an agent hanging', async () => {
  const abort = new AbortController(), c = taskController(pool(), { ...ctx, signal: abort.signal });
  const pending = c.execute('run_command', { command: 'npm test' }, {}, () => assert.fail());
  const rejected = assert.rejects(pending, /not approved/);
  abort.abort(); await rejected;
  assert.equal((await c.read()).approvals[0].status, 'cancelled');
});
test('recovery uses completed records and marks uncertain calls without repeating them', () => {
  const state = emptyTaskState();
  state.thread = [{ role: 'assistant', tool_calls: [{ id: 'complete' }, { id: 'unknown' }] }];
  state.journal = [{ id: 'complete', status: 'completed', output: 'wrote file' }, { id: 'unknown', status: 'started' }];
  const thread = recoverThread(state);
  assert.equal(thread[1].content, 'wrote file');
  assert.match(thread[2].content, /Do not repeat/);
  assert.equal(state.thread.length, 1);
});
test('specialist results and plan blockers are persisted', async () => {
  const c = taskController(pool(), ctx);
  await c.execute('update_plan', { steps: [{ text: 'Inspect', status: 'blocked', blocker: 'Missing input' }] }, {}, () => assert.fail());
  await c.execute('delegate_specialist', { role: 'review', task: 'Inspect auth' }, {}, () => assert.fail(), async () => 'Finding in auth.js');
  const state = await c.read();
  assert.equal(state.plan[0].blocker, 'Missing input');
  assert.equal(state.specialists[0].report, 'Finding in auth.js');
});

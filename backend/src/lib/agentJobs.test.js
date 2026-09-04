import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  startJob,
  stopJob,
  enqueue,
  subscribe,
  isJobLive,
  getOwnedConversation,
  _resetJobsForTests,
  driveControl,
} from './agentJobs.js';

function makePool() {
  const convos = new Map();
  return {
    convos,
    async query(sql, params) {
      const s = String(sql).replace(/\s+/g, ' ');
      if (s.includes('INSERT INTO conversations')) {
        const row = {
          id: params[0],
          user_id: params[1],
          repo_path: params[2],
          title: params[3],
          messages: [],
          run_status: 'idle',
          run_error: null,
          run_queue: [],
          updated_at: new Date(),
        };
        convos.set(row.id, row);
        return { rows: [row] };
      }
      if (s.includes('SELECT * FROM conversations')) {
        const row = [...convos.values()].find(r => r.user_id === params[0] && r.id === params[1]);
        return { rows: row ? [row] : [] };
      }
      if (s.includes('SET messages =') && s.includes("run_status = 'running'")) {
        const row = convos.get(params[1]);
        row.messages = JSON.parse(params[2]);
        row.title = params[3];
        row.run_status = 'running';
        row.run_error = null;
        row.updated_at = new Date();
        return { rows: [row], rowCount: 1 };
      }
      if (s.includes('SET run_queue')) {
        const row = convos.get(params[1]);
        row.run_queue = JSON.parse(params[2]);
        return { rows: [row], rowCount: 1 };
      }
      if (s.includes("run_status = 'stopping'")) {
        const row = convos.get(params[1]);
        row.run_status = 'stopping';
        return { rows: [row], rowCount: 1 };
      }
      if (s.includes("run_status = 'idle'")) {
        const row = convos.get(params[1]);
        if (row) row.run_status = 'idle';
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (s.includes('SET messages')) {
        const row = convos.get(params[1]);
        row.messages = JSON.parse(params[2]);
        const st = s.match(/run_status = \$(\d+)/);
        if (st) row.run_status = params[Number(st[1]) - 1];
        const er = s.match(/run_error = \$(\d+)/);
        if (er) row.run_error = params[Number(er[1]) - 1];
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

const user = { uid: 'lyan', display_name: 'Lyan', email: 'a@b.c' };

describe('agentJobs', () => {
  const realSchedule = driveControl.schedule;
  beforeEach(() => {
    _resetJobsForTests();
    driveControl.schedule = () => {};
  });
  afterEach(() => {
    _resetJobsForTests();
    driveControl.schedule = realSchedule;
  });

  it('start persists the user message and marks the conversation running', async () => {
    const pool = makePool();
    const result = await startJob(pool, {
      user,
      repoPath: 'acme/website',
      prompt: 'fix the tests',
      mode: 'agent',
    });
    assert.equal(result.run_status, 'running');
    assert.equal(result.queued, false);
    const row = pool.convos.get(result.conversationId);
    assert.equal(row.run_status, 'running');
    assert.equal(row.messages[0].role, 'user');
    assert.equal(row.messages[0].content, 'fix the tests');
    assert.equal(isJobLive(result.conversationId), true);
  });

  it('a second start while running enqueues a followup', async () => {
    const pool = makePool();
    const first = await startJob(pool, { user, repoPath: 'acme/website', prompt: 'one' });
    const second = await startJob(pool, {
      user,
      conversationId: first.conversationId,
      repoPath: 'acme/website',
      prompt: 'two',
    });
    assert.equal(second.queued, true);
    assert.equal(second.item.kind, 'followup');
    const row = pool.convos.get(first.conversationId);
    assert.equal(row.run_queue.length, 1);
    assert.equal(row.run_queue[0].text, 'two');
  });

  it('stop sets idle when no in-memory job remains', async () => {
    const pool = makePool();
    const first = await startJob(pool, { user, repoPath: 'acme/website', prompt: 'one' });
    _resetJobsForTests();
    const result = await stopJob(pool, user.uid, first.conversationId);
    assert.equal(result.run_status, 'idle');
    assert.equal(pool.convos.get(first.conversationId).run_status, 'idle');
  });

  it('stop aborts a live job', async () => {
    const pool = makePool();
    const first = await startJob(pool, { user, repoPath: 'acme/website', prompt: 'one' });
    const result = await stopJob(pool, user.uid, first.conversationId);
    assert.equal(result.run_status, 'stopping');
  });

  it('second subscriber can read the current snapshot', async () => {
    const pool = makePool();
    const first = await startJob(pool, { user, repoPath: 'acme/website', prompt: 'one' });
    const snap = await getOwnedConversation(pool, user.uid, first.conversationId);
    assert.equal(snap.run_status, 'running');
    assert.equal(snap.messages[0].content, 'one');
    const seen = [];
    const unsub = subscribe(first.conversationId, ev => seen.push(ev));
    await enqueue(pool, user.uid, first.conversationId, { kind: 'steer', text: 'nudge' });
    unsub();
    assert.ok(seen.some(e => e.type === 'queue' && e.items[0].text === 'nudge'));
  });

  it('rejects a model no provider enables instead of running it on the active provider', async () => {
    const pool = makePool();
    const baseQuery = pool.query.bind(pool);
    pool.query = async (sql, params) => {
      if (String(sql).replace(/\s+/g, ' ').includes('FROM ai_providers')) {
        return {
          rows: [{
            id: 1,
            user_uid: user.uid,
            label: 'DS',
            provider: 'deepseek',
            base_url: null,
            api_key_enc: null,
            key_mask: null,
            validated_at: 1,
            default_model: 'deepseek-chat',
            model_cache: ['deepseek-chat'],
            enabled_models: ['deepseek-chat'],
            is_default: true,
            created: 1,
            updated: 1,
          }],
        };
      }
      return baseQuery(sql, params);
    };
    driveControl.schedule = realSchedule;

    const started = await startJob(pool, {
      user,
      repoPath: 'acme/website',
      prompt: 'hi',
      model: 'not-enabled-model',
    });
    const events = [];
    await new Promise(resolve => {
      const unsub = subscribe(started.conversationId, ev => {
        events.push(ev);
        if (ev.type === 'done') resolve();
      });
      void unsub;
    });
    const errEvt = events.find(e => e.type === 'status' && e.error);
    assert.ok(errEvt, 'expected an error status event');
    assert.match(errEvt.error, /not enabled/);
    const row = pool.convos.get(started.conversationId);
    assert.match(row.run_error ?? '', /not enabled/);
  });
});

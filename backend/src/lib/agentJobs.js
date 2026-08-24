// In-memory agent job registry — one active job per conversation in this process.
// Tab close does not stop the job. A core restart does (sweepStaleRuns → idle).

import { EventEmitter } from 'node:events';
import { decryptSecret, PROVIDERS, streamChat } from './ai.js';
import { TOOL_SCHEMAS, executeTool } from './agentTools.js';
import { touchSandbox } from './agentSandbox.js';
import { getMode } from './assistantModes.js';
import { runAgentLoop } from './agentLoop.js';
import {
  applyEvent,
  uid,
  shouldAutoCompact,
  withCompaction,
  buildModelContext,
  COMPACTION_PROMPT,
} from './chatApply.js';

const jobs = new Map();
const PERSIST_DEBOUNCE_MS = 500;

function queueId() {
  return uid('q');
}

export function conversationPublic(row) {
  return {
    id: row.id,
    repoPath: row.repo_path,
    title: row.title,
    messages: Array.isArray(row.messages) ? row.messages : [],
    updatedAt: row.updated_at instanceof Date ? row.updated_at.getTime() : new Date(row.updated_at).getTime(),
    run_status: row.run_status || 'idle',
    run_error: row.run_error ?? null,
    run_queue: Array.isArray(row.run_queue) ? row.run_queue : [],
  };
}

export async function sweepStaleRuns(pool) {
  const { rowCount } = await pool.query(
    `UPDATE conversations
        SET run_status = 'idle',
            run_error = COALESCE(run_error, 'Job lost on core restart. Send Continue to resume.'),
            updated_at = now()
      WHERE run_status IN ('running', 'stopping')`,
  );
  if (rowCount > 0) console.log(`[agentJobs] marked ${rowCount} interrupted run(s) idle`);
}

async function loadOwned(pool, userId, conversationId) {
  const { rows } = await pool.query(
    'SELECT * FROM conversations WHERE user_id = $1 AND id = $2',
    [userId, conversationId],
  );
  return rows[0] || null;
}

async function persistMessages(pool, job, extra = {}) {
  const fields = ['messages = $3::jsonb', 'updated_at = now()'];
  const values = [job.userId, job.conversationId, JSON.stringify(job.messages)];
  let n = 3;
  if (extra.run_status !== undefined) {
    fields.push(`run_status = $${++n}`);
    values.push(extra.run_status);
  }
  if (extra.run_error !== undefined) {
    fields.push(`run_error = $${++n}`);
    values.push(extra.run_error);
  }
  if (extra.run_queue !== undefined) {
    fields.push(`run_queue = $${++n}::jsonb`);
    values.push(JSON.stringify(extra.run_queue));
  }
  if (extra.title !== undefined) {
    fields.push(`title = $${++n}`);
    values.push(extra.title);
  }
  await pool.query(
    `UPDATE conversations SET ${fields.join(', ')} WHERE user_id = $1 AND id = $2`,
    values,
  );
}

async function loadPermissions(pool, userId, repoPath) {
  try {
    const { rows } = await pool.query(
      "SELECT value FROM prefs WHERE user_id = $1 AND key = 'assistant_profiles' LIMIT 1",
      [userId],
    );
    const profiles = rows[0]?.value?.repoProfiles;
    if (profiles && typeof profiles === 'object') return profiles[repoPath] ?? {};
  } catch {
    /* read-only defaults */
  }
  return {};
}

async function loadProvider(pool, userId, model) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_providers WHERE user_uid = $1 ORDER BY created',
    [userId],
  );
  if (rows.length === 0) return null;
  if (model) {
    const owner = rows.find(
      r =>
        (Array.isArray(r.enabled_models) && r.enabled_models.includes(model)) ||
        r.default_model === model,
    );
    if (owner) return owner;
  }
  return rows.find(r => r.is_default) ?? rows[0];
}

function broadcast(job, evt) {
  job.bus.emit('event', evt);
}

function attachJob(pool, seed) {
  const existing = jobs.get(seed.conversationId);
  if (existing) return existing;
  const job = {
    ...seed,
    bus: new EventEmitter(),
    abort: new AbortController(),
    persistTimer: null,
    running: false,
  };
  job.bus.setMaxListeners(50);
  jobs.set(seed.conversationId, job);
  return job;
}

function flushPersist(pool, job, extra) {
  if (job.persistTimer) {
    clearTimeout(job.persistTimer);
    job.persistTimer = null;
  }
  return persistMessages(pool, job, extra).catch(err => {
    console.error('[agentJobs] persist failed:', err.message);
  });
}

function debouncePersist(pool, job) {
  if (job.persistTimer) clearTimeout(job.persistTimer);
  job.persistTimer = setTimeout(() => {
    job.persistTimer = null;
    persistMessages(pool, job).catch(err => {
      console.error('[agentJobs] persist failed:', err.message);
    });
  }, PERSIST_DEBOUNCE_MS);
}

function emitJob(pool, job, ev) {
  if (ev.type === 'usage' || ev.type === 'heartbeat' || ev.type === 'status' || ev.type === 'queue') {
    broadcast(job, ev);
    return;
  }
  job.messages = applyEvent(job.messages, ev);
  broadcast(job, ev);
  const immediate = new Set([
    'tool_start',
    'tool_output',
    'tool_error',
    'steer_applied',
    'step_clear_preamble',
    'stream_retry',
  ]);
  if (immediate.has(ev.type)) flushPersist(pool, job);
  else if (ev.type === 'message_text' || ev.type === 'reasoning') debouncePersist(pool, job);
}

async function popQueueKind(pool, job, kind) {
  const row = await loadOwned(pool, job.userId, job.conversationId);
  const queue = Array.isArray(row?.run_queue) ? [...row.run_queue] : [];
  const idx = queue.findIndex(i => i.kind === kind);
  if (idx < 0) return null;
  const [item] = queue.splice(idx, 1);
  job.runQueue = queue;
  await pool.query(
    `UPDATE conversations SET run_queue = $3::jsonb, updated_at = now()
      WHERE user_id = $1 AND id = $2`,
    [job.userId, job.conversationId, JSON.stringify(queue)],
  );
  broadcast(job, { type: 'queue', items: queue });
  return item;
}

async function expandMentions(prompt, execute) {
  const mentions = [...String(prompt).matchAll(/(?:^|\s)@([\w./-]+)/g)].map(m => m[1]).slice(0, 3);
  if (mentions.length === 0) return prompt;
  const snippets = [];
  for (const p of mentions) {
    try {
      const content = await execute('read_file', { path: p });
      snippets.push(`--- ${p} ---\n${content}`);
    } catch {
      snippets.push(`--- ${p} --- (could not read)`);
    }
  }
  return `<referenced_files>\n${snippets.join('\n\n')}\n</referenced_files>\n\n${prompt}`;
}

async function compactIfNeeded(pool, job, providerRow, apiKey, model) {
  if (!shouldAutoCompact(job.messages)) return;
  const start = (() => {
    for (let i = job.messages.length - 1; i >= 0; i--) {
      if (job.messages[i]?.kind === 'compaction') return i + 1;
    }
    return 0;
  })();
  const transcript = job.messages
    .slice(start)
    .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(m.content || '').slice(0, 4000)}`)
    .join('\n\n');
  let out = '';
  try {
    await streamChat(
      {
        provider: providerRow.provider,
        apiKey,
        baseUrl: providerRow.base_url,
        model,
        messages: [
          { role: 'system', content: COMPACTION_PROMPT },
          { role: 'user', content: transcript || '(empty conversation)' },
        ],
        reasoningLevel: 'none',
        tools: null,
      },
      async evt => {
        if (evt.type === 'text') out += evt.text;
      },
    );
  } catch {
    return;
  }
  if (!out.trim()) return;
  job.messages = withCompaction(job.messages, out.trim());
  await flushPersist(pool, job);
  broadcast(job, { type: 'snapshot', conversation: conversationPublic({
    ...job.row,
    messages: job.messages,
    run_status: 'running',
    run_queue: job.runQueue,
    updated_at: new Date(),
  }) });
}

async function runTurn(pool, job, { prompt, images, existingUser }) {
  const row = await loadOwned(pool, job.userId, job.conversationId);
  if (!row) throw new Error('Conversation not found');
  job.row = row;
  job.messages = Array.isArray(row.messages) ? row.messages : job.messages;
  job.runQueue = Array.isArray(row.run_queue) ? row.run_queue : [];

  if (!existingUser) {
    const userMessage = {
      id: uid('u'),
      role: 'user',
      content: prompt,
      images: images?.length ? images : undefined,
      createdAt: Date.now(),
    };
    job.messages = [...job.messages, userMessage];
    await flushPersist(pool, job, { run_status: 'running', run_error: null });
    broadcast(job, { type: 'user_message', message: userMessage });
  } else {
    await flushPersist(pool, job, { run_status: 'running', run_error: null });
  }

  const providerRow = await loadProvider(pool, job.userId, job.model);
  if (!providerRow) throw new Error('No AI provider configured. Add one in Plugins.');
  const def = PROVIDERS[providerRow.provider];
  const apiKey = providerRow.api_key_enc ? decryptSecret(providerRow.api_key_enc) : null;
  if (!apiKey && def?.local !== true) {
    throw new Error('No API key configured for the assistant provider.');
  }

  const slash = job.repoPath.indexOf('/');
  const space = slash > 0 ? job.repoPath.slice(0, slash) : '';
  const repo = slash > 0 ? job.repoPath.slice(slash + 1) : job.repoPath;
  const permissions = await loadPermissions(pool, job.userId, job.repoPath);
  const toolCtx = {
    userId: job.userId,
    user: job.user,
    conversationId: job.conversationId,
    repoPath: job.repoPath,
  };
  const exec = async (name, args) => {
    const result = await executeTool(name, space, repo, args, permissions, toolCtx);
    return String(result?.output ?? result ?? '');
  };

  const mode = getMode(job.mode);
  const agentMode = job.mode === 'agent' || job.mode === 'debug';
  const { summary, history } = buildModelContext(job.messages.slice(0, -1));
  const modelPrompt = await expandMentions(prompt, exec).catch(() => prompt);

  const touch = () =>
    touchSandbox({
      userId: job.userId,
      user: job.user,
      conversationId: job.conversationId,
      repoPath: job.repoPath,
      space,
      repo,
    });

  await runAgentLoop(
    {
      systemPrompt: mode.systemPrompt,
      extraContext: job.extraContext,
      compactionSummary: summary ?? undefined,
      history,
      prompt: modelPrompt,
      images,
      provider: providerRow.provider,
      apiKey,
      baseUrl: providerRow.base_url,
      model: job.model || providerRow.default_model,
      reasoningLevel: job.reasoningLevel || 'none',
      tools: agentMode ? TOOL_SCHEMAS : null,
      signal: job.abort.signal,
    },
    ev => emitJob(pool, job, ev),
    {
      executeTool: exec,
      touchSandbox: touch,
      steerNext: () => popQueueKind(pool, job, 'steer'),
    },
  );

  await compactIfNeeded(pool, job, providerRow, apiKey, job.model || providerRow.default_model);
}

async function driveJob(pool, job) {
  job.running = true;
  try {
    await runTurn(pool, job, {
      prompt: job.pendingPrompt,
      images: job.pendingImages,
      existingUser: job.pendingExistingUser,
    });
    job.pendingExistingUser = false;

    for (;;) {
      if (job.abort.signal.aborted) break;
      const followup = await popQueueKind(pool, job, 'followup');
      if (!followup) break;
      job.abort = new AbortController();
      await runTurn(pool, job, { prompt: followup.text, images: followup.images });
    }

    await flushPersist(pool, job, { run_status: 'idle', run_error: null });
    broadcast(job, { type: 'status', run_status: 'idle' });
    broadcast(job, { type: 'done' });
  } catch (err) {
    const stopped = err?.name === 'AbortError';
    if (stopped) {
      emitJob(pool, job, { type: 'message_text', text: '\n\n> ⏹ Stopped.' });
      await flushPersist(pool, job, { run_status: 'idle', run_error: null });
      broadcast(job, { type: 'status', run_status: 'idle' });
      broadcast(job, { type: 'done' });
    } else {
      const msg = err instanceof Error ? err.message : 'The AI provider request failed.';
      emitJob(pool, job, { type: 'message_text', text: `\n\n> ⚠️ ${msg}` });
      await flushPersist(pool, job, { run_status: 'idle', run_error: msg });
      broadcast(job, { type: 'status', run_status: 'idle', error: msg });
      broadcast(job, { type: 'done' });
    }
  } finally {
    job.running = false;
    jobs.delete(job.conversationId);
  }
}

export const driveControl = {
  schedule: fn => setImmediate(fn),
};

export async function startJob(pool, {
  user,
  conversationId,
  repoPath,
  prompt,
  images,
  mode,
  model,
  reasoningLevel,
  extraContext,
}) {
  const userId = user.uid;
  let row = conversationId ? await loadOwned(pool, userId, conversationId) : null;
  if (!row) {
    if (!repoPath) throw Object.assign(new Error('repoPath is required'), { status: 400 });
    const id = `conv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const title = String(prompt || 'Untitled').slice(0, 48);
    const inserted = await pool.query(
      `INSERT INTO conversations (id, user_id, repo_path, title, messages, run_status)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 'idle') RETURNING *`,
      [id, userId, repoPath, title],
    );
    row = inserted.rows[0];
  }

  if (row.run_status === 'running' || jobs.has(row.id)) {
    const item = {
      id: queueId(),
      kind: 'followup',
      text: prompt || '(image)',
      ...(images?.length ? { images } : {}),
    };
    const queue = [...(Array.isArray(row.run_queue) ? row.run_queue : []), item];
    await pool.query(
      `UPDATE conversations SET run_queue = $3::jsonb, updated_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, row.id, JSON.stringify(queue)],
    );
    const live = jobs.get(row.id);
    if (live) {
      live.runQueue = queue;
      broadcast(live, { type: 'queue', items: queue });
    }
    return { conversationId: row.id, run_status: 'running', queued: true, item };
  }

  const userMessage = {
    id: uid('u'),
    role: 'user',
    content: prompt || '(image)',
    images: images?.length ? images : undefined,
    createdAt: Date.now(),
  };
  const messages = [...(Array.isArray(row.messages) ? row.messages : []), userMessage];
  const title = row.title && row.title !== 'Untitled'
    ? row.title
    : String(prompt || 'Untitled').slice(0, 48);

  await pool.query(
    `UPDATE conversations
        SET messages = $3::jsonb, title = $4, run_status = 'running', run_error = NULL, updated_at = now()
      WHERE user_id = $1 AND id = $2`,
    [userId, row.id, JSON.stringify(messages), title],
  );

  const job = attachJob(pool, {
    conversationId: row.id,
    userId,
    user: { uid: user.uid, name: user.display_name, email: user.email },
    repoPath: row.repo_path,
    messages,
    runQueue: Array.isArray(row.run_queue) ? row.run_queue : [],
    mode: mode || 'agent',
    model: model || '',
    reasoningLevel: reasoningLevel || 'none',
    extraContext: extraContext || '',
    pendingPrompt: prompt || '(image)',
    pendingImages: images,
    pendingExistingUser: true,
    row: { ...row, messages, title, run_status: 'running' },
  });

  driveControl.schedule(() => {
    driveJob(pool, job).catch(err => console.error('[agentJobs] drive failed:', err));
  });

  return { conversationId: row.id, run_status: 'running', queued: false };
}

export async function stopJob(pool, userId, conversationId) {
  const row = await loadOwned(pool, userId, conversationId);
  if (!row) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const job = jobs.get(conversationId);
  if (job) {
    await pool.query(
      `UPDATE conversations SET run_status = 'stopping', updated_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, conversationId],
    );
    job.abort.abort();
    return { ok: true, run_status: 'stopping' };
  }
  if (row.run_status !== 'idle') {
    await pool.query(
      `UPDATE conversations SET run_status = 'idle', updated_at = now()
        WHERE user_id = $1 AND id = $2`,
      [userId, conversationId],
    );
  }
  return { ok: true, run_status: 'idle' };
}

export async function enqueue(pool, userId, conversationId, { kind, text, images }) {
  if (kind !== 'steer' && kind !== 'followup') {
    throw Object.assign(new Error('kind must be steer or followup'), { status: 400 });
  }
  const row = await loadOwned(pool, userId, conversationId);
  if (!row) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const item = {
    id: queueId(),
    kind,
    text: text || '(image)',
    ...(images?.length ? { images } : {}),
  };
  const queue = [...(Array.isArray(row.run_queue) ? row.run_queue : []), item];
  await pool.query(
    `UPDATE conversations SET run_queue = $3::jsonb, updated_at = now()
      WHERE user_id = $1 AND id = $2`,
    [userId, conversationId, JSON.stringify(queue)],
  );
  const live = jobs.get(conversationId);
  if (live) {
    live.runQueue = queue;
    broadcast(live, { type: 'queue', items: queue });
  }
  return { item, run_queue: queue };
}

export async function dequeue(pool, userId, conversationId, itemId) {
  const row = await loadOwned(pool, userId, conversationId);
  if (!row) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const queue = (Array.isArray(row.run_queue) ? row.run_queue : []).filter(i => i.id !== itemId);
  await pool.query(
    `UPDATE conversations SET run_queue = $3::jsonb, updated_at = now()
      WHERE user_id = $1 AND id = $2`,
    [userId, conversationId, JSON.stringify(queue)],
  );
  const live = jobs.get(conversationId);
  if (live) {
    live.runQueue = queue;
    broadcast(live, { type: 'queue', items: queue });
  }
  return { run_queue: queue };
}

export async function getOwnedConversation(pool, userId, conversationId) {
  const row = await loadOwned(pool, userId, conversationId);
  if (!row) return null;
  const live = jobs.get(conversationId);
  if (live) {
    return conversationPublic({
      ...row,
      messages: live.messages,
      run_status: live.abort.signal.aborted ? 'stopping' : 'running',
      run_queue: live.runQueue,
    });
  }
  return conversationPublic(row);
}

export function subscribe(conversationId, write) {
  const job = jobs.get(conversationId);
  if (!job) return () => {};
  const onEvent = evt => {
    try {
      write(evt);
    } catch {
      /* subscriber gone */
    }
  };
  job.bus.on('event', onEvent);
  return () => job.bus.off('event', onEvent);
}

export function isJobLive(conversationId) {
  return jobs.has(conversationId);
}

/** Test helper — drop in-memory jobs between cases. */
export function _resetJobsForTests() {
  for (const job of jobs.values()) {
    if (job.persistTimer) clearTimeout(job.persistTimer);
    job.abort.abort();
  }
  jobs.clear();
}

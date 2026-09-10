import { taskController, readTaskState, mutateTaskState, projectMemory, recoverThread, validateSettings, workspaceActions, CONTROL_TOOLS, CONTROL_PROMPT } from './agentControl.js';
// In-memory agent job registry — one active job per conversation in this process.
// Tab close does not stop the job. A core restart does (sweepStaleRuns → idle).

import { EventEmitter } from 'node:events';
import { decryptSecret, PROVIDERS, streamChat } from './ai.js';
import { TOOL_SCHEMAS, executeTool, assertWritableAgentPath } from './agentTools.js';
import { touchSandbox, writeAttachmentFiles, extForMime } from './agentSandbox.js';
import { getMode } from './assistantModes.js';
import {
  resolveWorkspace,
  parseWorkspacePath,
  workspaceContextBlock,
  workspaceGitDir,
} from './workspaces.js';
import { runAgentLoop } from './agentLoop.js';
import { listSkills, formatSkillCatalog, expandMentions } from './agentSkills.js';
import {
  SUBMIT_ENV_FEEDBACK_SCHEMA,
  saveEnvFeedback,
  formatEnvAuditContext,
  collectToolFailures,
} from './envFeedback.js';
import {
  applyEvent,
  uid,
  shouldAutoCompact,
  withCompaction,
  buildModelContext,
  COMPACTION_PROMPT,
} from './chatApply.js';

const jobs = new Map();

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
  await pool.query(`UPDATE agent_task_state SET state = jsonb_set(state, '{interrupted}', 'true'::jsonb) WHERE state->>'finishedAt' IS NULL AND state->>'startedAt' IS NOT NULL`);
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

// The provider row a job runs on: the one whose enabled/default models
// contain the requested model, or the active provider when no model was
// requested. A requested model that no provider enables is rejected instead
// of silently executing on whatever provider happens to be active.
async function loadProvider(pool, userId, model) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_providers WHERE user_uid = $1 ORDER BY created',
    [userId],
  );
  if (rows.length === 0) return null;
  if (!model) return rows.find(r => r.is_default) ?? rows[0];
  const owner = rows.find(
    r =>
      (Array.isArray(r.enabled_models) && r.enabled_models.includes(model)) ||
      r.default_model === model,
  );
  if (!owner) {
    throw new Error(`'${model}' is not enabled on any AI provider. Enable it under Plugins → Nixre Assistant.`);
  }
  return owner;
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

// Streaming text/reasoning checkpoints. A fixed cadence instead of a trailing
// debounce: a debounce timer that resets on every token can postpone the write
// for a whole uninterrupted stream, so a hard core death loses minutes of
// transcript. With this cadence at most ~500ms of progress is ever unflushed.
const PERSIST_CADENCE_MS = 500;

function checkpointPersist(pool, job) {
  if (job.persistTimer) return;
  job.persistTimer = setTimeout(() => {
    job.persistTimer = null;
    persistMessages(pool, job).catch(err => {
      console.error('[agentJobs] persist failed:', err.message);
    });
  }, PERSIST_CADENCE_MS);
}

function emitJob(pool, job, ev) {
  if (ev.type === 'usage' || ev.type === 'heartbeat' || ev.type === 'status' || ev.type === 'queue') {
    broadcast(job, ev);
    return;
  }
  job.messages = applyEvent(job.messages, ev);
  broadcast(job, ev);
  const immediate = new Set([
    'tool_approval',
    'tool_approved',
    'tool_start',
    'tool_output',
    'tool_error',
    'steer_applied',
    'step_clear_preamble',
    'stream_retry',
  ]);
  if (immediate.has(ev.type)) flushPersist(pool, job);
  else if (ev.type === 'message_text' || ev.type === 'reasoning') checkpointPersist(pool, job);
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

async function compactIfNeeded(pool, job, providerRow, apiKey, model) {
  if (!shouldAutoCompact(job.messages)) return;
  const start = (() => {
    for (let i = job.messages.length - 1; i >= 0; i--) {
      if (job.messages[i]?.kind === 'compaction') return i + 1;
    }
    return 0;
  })();
  const { summary: previousSummary } = buildModelContext(job.messages);
  const transcript = job.messages
    .slice(start)
    .filter(m => m.role === 'user' || (m.role === 'assistant' && m.content))
    .map(m => `${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${String(m.content || '').slice(0, 4000)}`)
    .join('\n\n');
  let out = '';
  let failed = false;
  let reportedInput = 0, reportedOutput = 0;
  try {
    if (job.control) await job.control.beforeRound();
    await streamChat(
      {
        provider: providerRow.provider,
        apiKey,
        baseUrl: providerRow.base_url,
        model,
        messages: [
          { role: 'system', content: COMPACTION_PROMPT },
          ...(previousSummary ? [{ role: 'system', content: previousSummary }] : []),
          { role: 'user', content: transcript || '(empty conversation)' },
        ],
        reasoningLevel: 'none',
        tools: null,
        signal: job.abort.signal,
      },
      async evt => {
        if (evt.type === 'text') out += evt.text;
        if (evt.type === 'error') failed = true;
        if (evt.type === 'usage' && job.control) {
          const input = Math.max(reportedInput, Number(evt.usage.input) || 0), output = Math.max(reportedOutput, Number(evt.usage.output) || 0);
          await job.control.usage({ input: input - reportedInput, output: output - reportedOutput });
          reportedInput = input; reportedOutput = output;
        }
      },
    );
  } catch {
    return;
  }
  if (failed || job.abort.signal.aborted || !out.trim()) return;
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

async function runTurn(pool, job, { prompt, images, existingUser, jobKind }) {
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

  // Workspace resolution can hit the network (first GitHub clone) and fail
  // with a user-facing message — surface it instead of running the turn blind.
  // job.user carries the caller's uid/admin/blocked, which workspace
  // resolution needs to enforce repository visibility.
  const ws = await resolveWorkspace(pool, job.user, job.repoPath);
  const info = parseWorkspacePath(job.repoPath);
  const space = info.space;
  const repo = info.repo;
  const permissions = await loadPermissions(pool, job.userId, job.repoPath);
  const toolCtx = {
    onApproval: ev => emitJob(pool, job, ev),
    userId: job.userId,
    user: job.user,
    conversationId: job.conversationId,
    repoPath: job.repoPath,
    workspace: ws,
    mode: job.mode,
    signal: job.abort.signal,
    liveReads: true,
    space, repo,
  };
  const control = taskController(pool, toolCtx);
  job.control = control;
  const priorState = await control.read();
  const resumeThread = job.resume ? recoverThread(priorState) : undefined;
  await control.start({ mode: job.mode, model: job.model, reasoningLevel: job.reasoningLevel, extraContext: job.extraContext }, job.resume);
  const budgetTimer = setTimeout(() => job.abort.abort(), (await control.read()).settings.maxSeconds * 1000);
  job.budgetTimer = budgetTimer;
  const rawExecute = async (name, args) => {
    if (name === 'submit_env_feedback') {
      const saved = await saveEnvFeedback(pool, {
        userId: job.userId,
        conversationId: job.conversationId,
        repoPath: job.repoPath,
        report: args,
      });
      return JSON.stringify(saved);
    }
    const result = await executeTool(name, space, repo, args, permissions, toolCtx);
    return String(result?.output ?? result ?? '');
  };

  const exec = async (name, args, meta) => {
    if (name === 'write_file') {
      if (job.mode === 'plan') throw new Error('Plan mode cannot edit files');
      assertWritableAgentPath(args.path, permissions);
    }
    if (['run_command', 'verify_project'].includes(name) && permissions.canRunBash === false && permissions.canRunTests === false) throw new Error('Command execution is disabled by the repository profile');
    if (job.mode === 'plan' && ['run_command', 'verify_project', 'browser_check'].includes(name)) throw new Error('Plan mode cannot execute commands or browser checks');
    return control.execute(name, args, meta, rawExecute, async (role, task) => {
      let report = '';
      await runAgentLoop({
        systemPrompt: `You are a ${role} specialist. Inspect the assigned task and return concrete findings with file references. Do not edit files, run commands, or delegate.`,
        extraContext: workspaceContextBlock(ws), history: [], prompt: task,
        provider: providerRow.provider, apiKey, baseUrl: providerRow.base_url,
        model: job.model || providerRow.default_model, maxRounds: 8,
        tools: TOOL_SCHEMAS.filter(t => ['list_files', 'read_file', 'search_code', 'read_skill'].includes(t.name)),
        signal: job.abort.signal,
      }, ev => { if (ev.type === 'message_text') report += ev.text; }, {
        executeTool: (name, args) => {
          if (!['list_files', 'read_file', 'search_code', 'read_skill'].includes(name)) throw new Error('Specialists are strictly read-only');
          return rawExecute(name, args);
        }, beforeRound: control.beforeRound, onUsage: control.usage,
      });
      return report || 'No findings returned';
    });
  };
  const mode = getMode(job.mode);
  const turnKind = jobKind || job.kind || 'chat';
  const isPlanMode = job.mode === 'plan';
  const agentMode = job.mode === 'agent' || job.mode === 'debug' || turnKind === 'env_audit';
  const useTools = agentMode || isPlanMode;

  // Pasted/attached files: drop them into the sandbox and reference them by
  // path in a <user-file-attached> block instead of inlining them into the
  // provider request. Ask mode cannot open sandbox files (no tools), so it
  // keeps inline behavior. Plan and Agent modes drop into sandbox.
  let inlineImages = images;
  let attachmentBlock = '';
  if (useTools && Array.isArray(images) && images.length > 0) {
    const att = await writeAttachmentFiles({
      userId: job.userId,
      conversationId: job.conversationId,
      repoPath: job.repoPath,
      space,
      repo,
      user: job.user,
      groupId: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      files: images.map((img, i) => ({
        name: img.name || `image-${i + 1}.${extForMime(img.mime)}`,
        mime: img.mime,
        data: Buffer.from(String(img.dataUrl || '').split(',').pop() || '', 'base64'),
      })),
    }).catch(err => {
      console.warn('[agentJobs] attachment drop failed:', err.message);
      return null;
    });
    if (att && att.written.length > 0) {
      const failedIdx = new Set(att.failed.map(f => f.index));
      inlineImages = images.filter((_, i) => failedIdx.has(i));
      const lines = att.written.map(w => `- ${w.path}`);
      attachmentBlock = `\n\n<user-file-attached>\nThe user has attached ${att.written.length} file${att.written.length === 1 ? '' : 's'}. ${att.written.length === 1 ? 'It is' : 'They are'} saved in your sandbox workspace at:\n${lines.join('\n')}\nInspect them with run_command (pdftotext for PDFs); show images to the user with show_images.\n</user-file-attached>`;
    }
    // att === null (no sandbox) or everything failed → inlineImages stays as
    // the original list and the provider gets them inline, as before.
  }

  // Skills live on HEAD of the working tree source: hosted bare for nixre,
  // the local mirror for GitHub targets.
  const skillsDir = ws.kind === 'github' ? workspaceGitDir(ws) : undefined;
  const skills = await listSkills(space, repo, skillsDir).catch(() => []);
  const extras = [];
  // Workspace target first: the <workspace> block grounds every later context.
  extras.push(workspaceContextBlock(ws));
  extras.push(CONTROL_PROMPT);
  const memory = await projectMemory(pool, job.userId, job.repoPath);
  if (memory) extras.push(`<project_memory>\n${memory}\n</project_memory>`);
  if (job.extraContext) extras.push(job.extraContext);
  const catalog = formatSkillCatalog(skills);
  if (catalog) extras.push(catalog);
  if (turnKind === 'env_audit') {
    extras.push(
      formatEnvAuditContext({
        permissions,
        tools: [
          ...TOOL_SCHEMAS.map(t => t.name),
          SUBMIT_ENV_FEEDBACK_SCHEMA.name,
        ],
        failures: collectToolFailures(job.messages),
      }),
    );
  }
  const { summary, history } = buildModelContext(job.messages.slice(0, -1));
  const modelPrompt = await expandMentions(prompt, { execute: exec, skills }).catch(() => prompt);
  const finalPrompt = attachmentBlock ? `${modelPrompt}${attachmentBlock}` : modelPrompt;
  let tools = agentMode
    ? turnKind === 'env_audit'
      ? [...TOOL_SCHEMAS, ...CONTROL_TOOLS, SUBMIT_ENV_FEEDBACK_SCHEMA]
      : [...TOOL_SCHEMAS, ...CONTROL_TOOLS]
    : isPlanMode
      ? [...TOOL_SCHEMAS.filter(t => !['write_file', 'run_command'].includes(t.name)), ...CONTROL_TOOLS.filter(t => ['update_plan', 'delegate_specialist'].includes(t.name))]
      : null;

  const preset = (await control.read()).settings.preset;
  if (tools && preset === 'read_only') tools = tools.filter(t => !['write_file', 'run_command', 'verify_project', 'browser_check'].includes(t.name));
  if (tools && preset === 'restricted') tools = tools.filter(t => t.name !== 'run_command');

  const touch = () =>
    touchSandbox({
      userId: job.userId,
      user: job.user,
      conversationId: job.conversationId,
      repoPath: job.repoPath,
      space,
      repo,
    });

  if (resumeThread?.length) {
    resumeThread.push({ role: 'system', content: `Current workspace and user memory:\n${extras.join('\n\n')}` });
    resumeThread.push({ role: 'user', content: finalPrompt });
  }
  await runAgentLoop(
    {
      systemPrompt: mode.systemPrompt,
      resumeThread,
      extraContext: extras.join('\n\n'),
      compactionSummary: summary ?? undefined,
      history,
      prompt: finalPrompt,
      images: inlineImages,
      provider: providerRow.provider,
      apiKey,
      baseUrl: providerRow.base_url,
      model: job.model || providerRow.default_model,
      reasoningLevel: job.reasoningLevel || 'none',
      tools,
      signal: job.abort.signal,
    },
    ev => emitJob(pool, job, ev),
    {
      executeTool: exec,
      beforeRound: control.beforeRound,
      onUsage: control.usage,
      saveThread: control.saveThread,
      touchSandbox: touch,
      steerNext: () => popQueueKind(pool, job, 'steer'),
    },
  );

  clearTimeout(job.budgetTimer);
  job.resume = false;
  await compactIfNeeded(pool, job, providerRow, apiKey, job.model || providerRow.default_model);
}

async function driveJob(pool, job) {
  if (job.running) return;
  job.running = true;
  try {
    await runTurn(pool, job, {
      prompt: job.pendingPrompt,
      images: job.pendingImages,
      existingUser: job.pendingExistingUser,
      jobKind: job.kind,
    });
    job.pendingExistingUser = false;

    for (;;) {
      if (job.abort.signal.aborted) break;
      const followup = await popQueueKind(pool, job, 'followup');
      if (!followup) break;
      job.abort = new AbortController();
      await runTurn(pool, job, {
        prompt: followup.text,
        images: followup.images,
        jobKind: followup.jobKind,
      });
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
    clearTimeout(job.budgetTimer);
    if (job.control) await job.control.mutate(s => { s.finishedAt = Date.now(); }).catch(() => {});
    job.running = false;
    jobs.delete(job.conversationId);
  }
}

export const driveControl = {
  schedule: fn => setImmediate(fn),
};

async function startJobUnlocked(pool, {
  user,
  conversationId,
  repoPath,
  prompt,
  images,
  mode,
  model,
  reasoningLevel,
  extraContext,
  kind,
  resume = false,
  taskSettings,
}) {
  const userId = user.uid;
  const initialSettings = taskSettings ? validateSettings(taskSettings) : undefined;
  let row = conversationId ? await loadOwned(pool, userId, conversationId) : null;
  if (conversationId && !row) throw Object.assign(new Error('Conversation not found'), { status: 404 });
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
    if (initialSettings) await mutateTaskState(pool, row.id, s => { s.settings = initialSettings; });
  }

  if (workspaceActions.has(row.id)) throw Object.assign(new Error('A workspace operation is still running'), { status: 409 });
  if (row.run_status === 'running' || jobs.has(row.id)) {
    const item = {
      id: queueId(),
      kind: 'followup',
      text: prompt || '(image)',
      ...(images?.length ? { images } : {}),
      ...(kind === 'env_audit' ? { jobKind: 'env_audit' } : {}),
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
    user: { ...user, uid: user.uid, name: user.display_name, email: user.email },
    resume,
    repoPath: row.repo_path,
    messages,
    runQueue: Array.isArray(row.run_queue) ? row.run_queue : [],
    mode: mode || 'agent',
    model: model || '',
    reasoningLevel: reasoningLevel || 'none',
    extraContext: extraContext || '',
    kind: kind === 'env_audit' ? 'env_audit' : 'chat',
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

export async function enqueue(pool, userId, conversationId, { kind, text, images, jobKind }) {
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
    ...(jobKind === 'env_audit' ? { jobKind: 'env_audit' } : {}),
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

// Serialize starts for an existing conversation so concurrent requests cannot
// schedule two drivers or overwrite the newly persisted opening turn.
const startLocks = new Map();
export async function startJob(pool, args) {
  if (!args.conversationId) return startJobUnlocked(pool, args);
  const key = `${args.user.uid}:${args.conversationId}`;
  const previous = startLocks.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(() => startJobUnlocked(pool, args));
  startLocks.set(key, next);
  try { return await next; } finally { if (startLocks.get(key) === next) startLocks.delete(key); }
}

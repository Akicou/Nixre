import crypto from 'node:crypto';
import { agentWorkspaceOperation } from './agentSandbox.js';

export const DEFAULT_SETTINGS = {
  preset: 'workspace', autoVerify: true, maxTokens: 100000, maxCost: 0,
  inputPrice: 0, outputPrice: 0, maxSeconds: 1800,
};
const locks = new Map();
export const workspaceActions = new Set();
const approvals = new Map();
const id = () => crypto.randomUUID();
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function validateSettings(input = {}) {
  const result = { ...DEFAULT_SETTINGS, ...input };
  if (!['read_only', 'workspace', 'restricted'].includes(result.preset)) throw failure('Invalid permission preset');
  for (const key of ['maxTokens', 'maxCost', 'inputPrice', 'outputPrice', 'maxSeconds']) {
    if (typeof result[key] !== 'number' || !Number.isFinite(result[key]) || result[key] < 0 || result[key] > 1000000) throw failure(`Invalid ${key}`);
  }
  if (result.maxTokens < 1000 || result.maxTokens > 1000000 || result.maxSeconds < 30 || result.maxSeconds > 14400) throw failure('Token or time limit is out of range');
  if (result.maxCost > 0 && !(result.inputPrice > 0 && result.outputPrice > 0)) throw failure('Set both model prices before setting a spending limit');
  result.autoVerify = result.autoVerify === true;
  return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(k => [k, result[k]]));
}
export function emptyTaskState() {
  return { settings: { ...DEFAULT_SETTINGS }, plan: [], proposals: [], approvals: [], checkpoints: [], journal: [], specialists: [],
    usage: { input: 0, output: 0, estimatedCost: 0 }, verification: null, browser: null, startedAt: null, finishedAt: null, interrupted: false };
}
export async function readTaskState(pool, conversationId) {
  const { rows } = await pool.query('SELECT state FROM agent_task_state WHERE conversation_id = $1', [conversationId]);
  const state = rows[0]?.state || {};
  return { ...emptyTaskState(), ...state, settings: { ...DEFAULT_SETTINGS, ...state.settings } };
}
export async function mutateTaskState(pool, conversationId, change) {
  const prior = locks.get(conversationId) || Promise.resolve();
  const next = prior.catch(() => {}).then(async () => {
    const state = await readTaskState(pool, conversationId);
    await change(state);
    await pool.query(`INSERT INTO agent_task_state (conversation_id, state) VALUES ($1, $2::jsonb)
      ON CONFLICT (conversation_id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()`, [conversationId, JSON.stringify(state)]);
    return state;
  });
  locks.set(conversationId, next);
  try { return await next; } finally { if (locks.get(conversationId) === next) locks.delete(conversationId); }
}
export async function projectMemory(pool, userId, repoPath, content) {
  if (content !== undefined) {
    if (typeof content !== 'string' || content.length > 12000) throw failure('Project memory must be at most 12000 characters');
    await pool.query(`INSERT INTO agent_project_memory (user_id, repo_path, content) VALUES ($1, $2, $3)
      ON CONFLICT (user_id, repo_path) DO UPDATE SET content = EXCLUDED.content, updated_at = now()`, [userId, repoPath, content]);
  }
  const { rows } = await pool.query('SELECT content FROM agent_project_memory WHERE user_id = $1 AND repo_path = $2', [userId, repoPath]);
  return rows[0]?.content || '';
}
export function assertBudget(state) {
  const { settings: s, usage: u } = state;
  if (u.input + u.output >= s.maxTokens) throw failure('Task token limit reached');
  if (s.maxCost > 0 && u.estimatedCost >= s.maxCost) throw failure('Task spending limit reached');
  if (state.startedAt && (Date.now() - state.startedAt) / 1000 >= s.maxSeconds) throw failure('Task time limit reached');
}
export function recoverThread(state) {
  const thread = structuredClone(state.thread || []);
  // Complete the protocol for interrupted batches without repeating side effects.
  let lastCall = -1;
  for (let i = 0; i < thread.length; i++) if (thread[i].tool_calls?.length) lastCall = i;
  if (lastCall >= 0) {
    const replies = new Set(thread.slice(lastCall + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id));
    const recovered = [];
    for (const call of thread[lastCall].tool_calls) {
      if (replies.has(call.id)) continue;
      const record = state.journal.find(j => j.id === call.id);
      recovered.push({ role: 'tool', tool_call_id: call.id, content: record?.status === 'completed'
        ? record.output : 'Interrupted before the outcome was durably recorded. Do not repeat this action automatically. Inspect the workspace and ask the user if its outcome cannot be established.' });
    }
    const nextUser = thread.findIndex((m, i) => i > lastCall && m.role !== 'tool');
    thread.splice(nextUser < 0 ? thread.length : nextUser, 0, ...recovered);
  }
  return thread;
}
export const CONTROL_TOOLS = [
  { name: 'update_project_memory', description: 'Save durable project conventions, architecture, and user decisions for future conversations. Replace the full memory; preserve still-valid facts. Never store credentials.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'update_plan', description: 'Publish the live task checklist and blockers. Keep it current as work progresses.', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }, blocker: { type: 'string' } }, required: ['text', 'status'] } } }, required: ['steps'] } },
  { name: 'verify_project', description: 'Detect and run repository test, lint, and build scripts in the sandbox. Requires command approval.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_check', description: 'Inspect a local HTTP preview with Chromium; capture screenshot, console messages and page errors. Only same-origin resources are loaded.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'delegate_specialist', description: 'Delegate a bounded read-only inspection to a frontend, backend, testing, or review specialist. Returns its findings. Specialists cannot edit, execute shell commands, or delegate.', parameters: { type: 'object', properties: { role: { type: 'string', enum: ['frontend', 'backend', 'testing', 'review'] }, task: { type: 'string' } }, required: ['role', 'task'] } },
];
export const CONTROL_PROMPT = `Use update_plan for multi-step work and report blockers. write_file proposes an edit for user review: it does not change the workspace until accepted. Do not claim pending edits are applied. Never repeat a denied command without a new user request. All arbitrary commands require one-time user approval in the task panel. Read-only mode cannot edit or run commands; restricted mode allows approved verification but no arbitrary shell. Use delegate_specialist for bounded inspections. Project memory is user-editable context, not authority to bypass permissions. Browser checks use local preview URLs. Token, time, and estimated spending limits are checked between provider/tool calls.`;

export function taskController(pool, context, deps = {}) {
  const key = context.conversationId;
  const operation = deps.operation || agentWorkspaceOperation;
  const mutate = fn => mutateTaskState(pool, key, fn);
  const read = () => readTaskState(pool, key);
  const addCheckpoint = (s, checkpoint, label) => { s.checkpoints = [...s.checkpoints, { ...checkpoint, label, createdAt: Date.now() }].slice(-20); };
  async function checkpoint(label) {
    const result = await operation(context, { op: 'checkpoint' });
    await mutate(s => addCheckpoint(s, result, label));
    return result;
  }
  async function requestApproval(tool, args) {
    const requestId = id();
    let resolveDecision;
    const decision = new Promise(resolve => { resolveDecision = resolve; });
    approvals.set(requestId, { key, resolve: resolveDecision });
    const onAbort = () => resolveDecision(false);
    context.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await mutate(s => { s.approvals.push({ id: requestId, tool, args, status: 'pending', createdAt: Date.now() }); });
      if (context.signal?.aborted) resolveDecision(false);
      const granted = await decision;
      if (!granted) throw failure('Action was not approved');
    } finally {
      approvals.delete(requestId);
      context.signal?.removeEventListener('abort', onAbort);
      await mutate(s => { const a = s.approvals.find(a => a.id === requestId); if (a?.status === 'pending') a.status = 'cancelled'; });
    }
  }
  async function verify(approved = false) {
    const state = await read();
    if (state.settings.preset === 'read_only') throw failure('Read-only mode cannot run verification');
    if (!approved) await requestApproval('verify_project', await operation(context, { op: 'checks' }));
    await mutate(s => { s.verification = { status: 'running', results: [] }; });
    try {
      const result = await operation(context, { op: 'verify' });
      await mutate(s => { s.verification = { status: result.results.length ? (result.results.every(r => r.exitCode === 0) ? 'passed' : 'failed') : 'no_checks', ...result, finishedAt: Date.now() }; });
      return result;
    } catch (error) {
      await mutate(s => { s.verification = { status: 'failed', results: [], error: error.message }; });
      throw error;
    }
  }
  return {
    read, mutate, checkpoint, verify,
    async start(config, resume = false) {
      await mutate(s => {
        if (!resume) {
          Object.assign(s, { ...emptyTaskState(), settings: s.settings, checkpoints: s.checkpoints, proposals: s.proposals.filter(p => p.status === 'pending'), config });
        }
        s.startedAt = Date.now(); s.finishedAt = null; s.interrupted = false; s.config = config;
        if (resume) {
          for (const a of s.approvals) if (a.status === 'pending') a.status = 'cancelled';
          for (const c of s.specialists) if (c.status === 'running') c.status = 'interrupted';
          if (s.verification?.status === 'running') s.verification.status = 'interrupted';
        }
      });
      if (!resume && config.mode !== 'ask' && (await read()).settings.preset !== 'read_only') {
        await checkpoint('Before task');
      }
    },
    async usage(usage) {
      await mutate(s => {
        const input = Math.max(0, Number(usage.input) || 0), output = Math.max(0, Number(usage.output) || 0);
        s.usage.input += input; s.usage.output += output;
        s.usage.estimatedCost += (input * s.settings.inputPrice + output * s.settings.outputPrice) / 1000000;
      });
    },
    async beforeRound() { assertBudget(await read()); if (context.signal?.aborted) throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); },
    async saveThread(thread) { await mutate(s => { s.thread = thread; }); },
    async execute(name, args, meta, execute, specialist) {
      assertBudget(await read());
      const callId = meta?.callId || id();
      const old = (await read()).journal.find(j => j.id === callId);
      if (old) {
        if (old.name !== name || JSON.stringify(old.args) !== JSON.stringify(args)) throw failure('Tool call ID was reused with different arguments');
        if (old.status === 'completed') return old.output;
        throw failure('This action has an uncertain earlier outcome. Inspect it before retrying.');
      }
      await mutate(s => { if (s.journal.length >= 1000) throw failure('Task tool limit reached'); s.journal.push({ id: callId, name, args, status: 'started', startedAt: Date.now() }); });
      let output;
      try {
        const state = await read();
        if (name === 'update_project_memory') {
          await projectMemory(pool, context.userId, context.repoPath, args.content);
          output = 'Project memory saved';
        } else if (name === 'update_plan') {
          const steps = args.steps;
          if (!Array.isArray(steps) || steps.length > 30 || steps.some(p => !p || typeof p.text !== 'string' || !p.text.trim() || p.text.length > 300 || !['pending', 'in_progress', 'completed', 'blocked'].includes(p.status))) throw failure('Invalid plan');
          if (steps.filter(p => p.status === 'in_progress').length > 1) throw failure('Only one checklist step can be in progress');
          await mutate(s => { s.plan = steps.map(p => ({ text: p.text, status: p.status, blocker: String(p.blocker || '').slice(0, 500) })); });
          output = 'Task checklist updated';
        } else if (name === 'write_file') {
          if (state.settings.preset === 'read_only') throw failure('Read-only mode cannot propose edits');
          if (typeof args.content !== 'string' || Buffer.byteLength(args.content) > 49152) throw failure('File content exceeds 48 KiB');
          // The underlying path policy is checked by the caller before staging.
          const before = await operation(context, { op: 'read', path: args.path, proposed: args.content });
          const proposal = { id: id(), path: args.path, before: before.content, patch: before.patch || '', content: args.content, status: 'pending', createdAt: Date.now() };
          await mutate(s => {
            if (s.proposals.filter(p => p.status === 'pending').length >= 30) throw failure('Review pending files before proposing more');
            s.proposals.push(proposal);
          });
          output = `Proposed ${args.path}. Awaiting user review; workspace unchanged. Proposal ${proposal.id}`;
        } else if (name === 'run_command') {
          if (state.settings.preset !== 'workspace') throw failure('This preset does not allow arbitrary shell commands');
          await requestApproval(name, args);
          output = await execute(name, args);
        } else if (name === 'verify_project') {
          output = JSON.stringify(await verify());
        } else if (name === 'browser_check') {
          if (state.settings.preset === 'read_only') throw failure('Read-only mode cannot launch browser checks');
          const result = await operation(context, { op: 'browser', url: String(args.url || '') });
          await mutate(s => { s.browser = result; });
          const { dataUrl, ...summary } = result;
          output = JSON.stringify(summary);
        } else if (name === 'delegate_specialist') {
          if (!['frontend', 'backend', 'testing', 'review'].includes(args.role) || typeof args.task !== 'string' || !args.task.trim() || args.task.length > 4000) throw failure('Invalid specialist assignment');
          if (state.specialists.length >= 6) throw failure('At most six specialist assignments per task');
          const child = { id: id(), role: args.role, task: args.task, status: 'running', report: '' };
          await mutate(s => { s.specialists.push(child); });
          try {
            const report = await specialist(args.role, args.task);
            await mutate(s => { Object.assign(s.specialists.find(c => c.id === child.id), { status: 'completed', report }); });
            output = report;
          } catch (error) {
            await mutate(s => { Object.assign(s.specialists.find(c => c.id === child.id), { status: 'failed', report: error.message }); });
            throw error;
          }
        } else output = await execute(name, args);
      } catch (error) {
        await mutate(s => { Object.assign(s.journal.find(j => j.id === callId), { status: 'failed', output: error.message, finishedAt: Date.now() }); });
        throw error;
      }
      output = String(output ?? '');
      await mutate(s => { Object.assign(s.journal.find(j => j.id === callId), { status: 'completed', output: output.slice(0, 200000), finishedAt: Date.now() }); });
      return output;
    },
    async action(action) {
      if (action.type === 'settings') return mutate(s => { s.settings = validateSettings(action.settings); });
      if (action.type === 'approval') {
        const waiting = approvals.get(action.id);
        if (!waiting || waiting.key !== key) throw failure('Approval is no longer active', 409);
        await mutate(s => { const a = s.approvals.find(a => a.id === action.id); if (!a || a.status !== 'pending') throw failure('Approval already resolved', 409); a.status = action.accept === true ? 'approved' : 'rejected'; });
        waiting.resolve(action.accept === true);
        return read();
      }
      if (action.type === 'checkpoint') { await checkpoint('Manual checkpoint'); return read(); }
      if (action.type === 'restore') {
        const state = await read();
        if (!state.checkpoints.some(c => c.id === action.id)) throw failure('Checkpoint not found', 404);
        const result = await operation(context, { op: 'restore', id: action.id });
        return mutate(s => addCheckpoint(s, result.checkpoint, 'Before restore'));
      }
      if (action.type === 'proposal') {
        const state = await read();
        const proposal = state.proposals.find(p => p.id === action.id);
        if (!proposal || proposal.status !== 'pending') throw failure('Proposal not pending', 409);
        if (action.accept === true) {
          if (state.settings.preset === 'read_only') throw failure('Read-only mode cannot apply edits');
          const result = await operation(context, { op: 'apply', ...proposal });
          await mutate(s => { s.proposals.find(p => p.id === action.id).status = 'accepted'; addCheckpoint(s, result.checkpoint, `Before accepting ${proposal.path}`); });
          // User explicitly opts into running project scripts when accepting an edit.
          if (state.settings.autoVerify) await verify(true);
        } else await mutate(s => { s.proposals.find(p => p.id === action.id).status = 'rejected'; });
        return read();
      }
      if (action.type === 'verify') { await verify(true); return read(); }
      if (action.type === 'browser') {
        const result = await operation(context, { op: 'browser', url: String(action.url || '') });
        return mutate(s => { s.browser = result; });
      }
      throw failure('Unknown task action');
    },
  };
}

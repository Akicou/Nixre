import { assertWritableAgentPath } from '../lib/agentTools.js';
import { taskController, projectMemory, readTaskState, workspaceActions } from '../lib/agentControl.js';
import { resolveWorkspace, parseWorkspacePath } from '../lib/workspaces.js';
import { isJobLive, startJob } from '../lib/agentJobs.js';

const busy = workspaceActions;
export async function ownedControlContext(pool, user, conversationId) {
  const { rows } = await pool.query('SELECT * FROM conversations WHERE user_id = $1 AND id = $2', [user.uid, conversationId]);
  const row = rows[0];
  if (!row) throw Object.assign(new Error('Conversation not found'), { status: 404 });
  const workspace = await resolveWorkspace(pool, user, row.repo_path);
  const target = parseWorkspacePath(row.repo_path);
  const context = { userId: user.uid, user: { ...user, name: user.display_name }, conversationId, repoPath: row.repo_path, workspace, space: target.space, repo: target.repo };
  return { row, context };
}
export function publicTaskState(state) {
  const { thread, config, ...visible } = state;
  return { ...visible, canResume: Boolean(thread?.length), journal: visible.journal.map(({ args, output, ...j }) => j) };
}
export function installAgentControlRoutes(api, pool, auth) {
  api.get('/ai/jobs/:conversationId/controls', auth, async (req, res) => {
    try {
      const { context } = await ownedControlContext(pool, req.auth.user, req.params.conversationId);
      res.json({ ...publicTaskState(await readTaskState(pool, context.conversationId)), memory: await projectMemory(pool, context.userId, context.repoPath) });
    } catch (err) { res.status(err.status || 400).json({ message: err.message }); }
  });
  api.post('/ai/jobs/:conversationId/controls', auth, async (req, res) => {
    const key = req.params.conversationId;
    let acquired = false;
    try {
      const { context, row } = await ownedControlContext(pool, req.auth.user, key);
      const action = req.body || {};
      if (action.type !== 'approval') {
        if (busy.has(key) || isJobLive(key)) throw Object.assign(new Error('Wait for the active agent operation to finish or stop the task first'), { status: 409 });
        busy.add(key); acquired = true;
      }
      const control = taskController(pool, context);
      if (action.type === 'memory') {
        await projectMemory(pool, context.userId, context.repoPath, action.content);
      } else if (action.type === 'resume') {
        const state = await control.read();
        if (!state.thread?.length) throw new Error('No saved task is available to resume');
        busy.delete(key); acquired = false;
        const result = await startJob(pool, { ...state.config, user: req.auth.user, conversationId: key, repoPath: row.repo_path,
          prompt: 'Continue the saved task. Inspect uncertain actions before doing more work.', resume: true });
        res.json({ ...publicTaskState(await control.read()), resumed: result.conversationId });
        return;
      } else {
        const state = await control.read();
        if (state.settings.preset === 'read_only' && ['restore', 'verify', 'browser'].includes(action.type)) throw new Error('Read-only mode cannot perform this operation');
        if (['verify', 'proposal', 'restore', 'browser'].includes(action.type)) {
          const { rows } = await pool.query("SELECT value FROM prefs WHERE user_id = $1 AND key = 'assistant_profiles' LIMIT 1", [context.userId]);
          const profile = rows[0]?.value?.repoProfiles?.[context.repoPath] || {};
          if (action.type === 'proposal' && action.accept === true) {
            const proposal = state.proposals.find(p => p.id === action.id);
            if (proposal) assertWritableAgentPath(proposal.path, profile);
          }
          if (['restore', 'proposal'].includes(action.type) && profile.canRunBash === false) throw new Error('Repository profile does not allow file edits');
          if (['verify', 'browser'].includes(action.type) && profile.canRunBash === false && profile.canRunTests === false) throw new Error('Repository profile does not allow execution');
        }
        await control.action(action);
      }
      res.json({ ...publicTaskState(await control.read()), memory: await projectMemory(pool, context.userId, context.repoPath) });
    } catch (err) { res.status(err.status || 400).json({ message: err.message }); }
    finally { if (acquired) busy.delete(key); }
  });
}

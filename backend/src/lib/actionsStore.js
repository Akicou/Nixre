// Postgres persistence for Nixre Actions. The engine only talks to this
// interface, so its tests swap in an in-memory store (actions.test.js).

const JSON_COLS = new Set(['inputs', 'matrix', 'needs', 'steps']);

function setClause(fields, startAt = 1) {
  const keys = Object.keys(fields);
  return {
    sql: keys.map((k, i) => `${k} = $${i + startAt}${JSON_COLS.has(k) ? '::jsonb' : ''}`).join(', '),
    values: keys.map(k => (JSON_COLS.has(k) ? JSON.stringify(fields[k]) : fields[k])),
  };
}

export function createPgStore(pool) {
  return {
    async getRepo(id) {
      return (await pool.query('SELECT * FROM repos WHERE id = $1', [id])).rows[0] || null;
    },
    async findRepo(space, uid) {
      return (await pool.query('SELECT * FROM repos WHERE space_uid = $1 AND uid = $2', [space, uid])).rows[0] || null;
    },
    async listRepos() {
      return (await pool.query('SELECT * FROM repos ORDER BY id')).rows;
    },

    /** Insert a run with the next per-repo run_number (retries on a race). */
    async createRun(repoId, f) {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const { rows } = await pool.query(
            `INSERT INTO workflow_runs
               (repo_id, run_number, workflow_path, workflow_name, event, ref, sha, pr_number,
                actor, inputs, status, conclusion, error, created, started, finished)
             SELECT $1, coalesce(max(run_number), 0) + 1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb,
                    $10, $11, $12, $13, $14, $15
               FROM workflow_runs WHERE repo_id = $1
             RETURNING *`,
            [
              repoId, f.workflow_path, f.workflow_name, f.event, f.ref, f.sha, f.pr_number ?? null,
              f.actor || '', JSON.stringify(f.inputs || {}), f.status || 'queued', f.conclusion ?? null,
              f.error ?? null, f.created, f.started ?? null, f.finished ?? null,
            ],
          );
          return rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
        }
      }
      throw new Error('Could not allocate a run number');
    },
    async createJob(runId, f) {
      const { rows } = await pool.query(
        `INSERT INTO workflow_jobs (run_id, job_key, name, matrix, needs, image, status, conclusion, steps)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb) RETURNING *`,
        [
          runId, f.job_key, f.name, JSON.stringify(f.matrix || {}), JSON.stringify(f.needs || []),
          f.image || '', f.status || 'queued', f.conclusion ?? null, JSON.stringify(f.steps || []),
        ],
      );
      return rows[0];
    },
    async updateRun(id, fields) {
      const { sql, values } = setClause(fields);
      const { rows } = await pool.query(
        `UPDATE workflow_runs SET ${sql} WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      return rows[0];
    },
    async updateJob(id, fields) {
      const { sql, values } = setClause(fields);
      const { rows } = await pool.query(
        `UPDATE workflow_jobs SET ${sql} WHERE id = $${values.length + 1} RETURNING *`,
        [...values, id],
      );
      return rows[0];
    },
    async getRun(id) {
      return (await pool.query('SELECT * FROM workflow_runs WHERE id = $1', [id])).rows[0] || null;
    },
    async getRunByNumber(repoId, number) {
      return (
        await pool.query('SELECT * FROM workflow_runs WHERE repo_id = $1 AND run_number = $2', [repoId, number])
      ).rows[0] || null;
    },
    async listRuns(repoId, { workflow, branch, event, limit = 30, offset = 0 } = {}) {
      const where = ['repo_id = $1'];
      const params = [repoId];
      if (workflow) where.push(`workflow_path = $${params.push(workflow)}`);
      if (branch) where.push(`ref = $${params.push(`refs/heads/${branch}`)}`);
      if (event) where.push(`event = $${params.push(event)}`);
      const { rows } = await pool.query(
        `SELECT * FROM workflow_runs WHERE ${where.join(' AND ')}
          ORDER BY id DESC LIMIT $${params.push(limit)} OFFSET $${params.push(offset)}`,
        params,
      );
      return rows;
    },
    /** Latest completed run for a badge: by workflow file and branch. */
    async latestCompletedRun(repoId, { workflow, branch }) {
      const where = ["repo_id = $1", "status = 'completed'", "event <> 'pull_request'"];
      const params = [repoId];
      if (workflow) where.push(`(workflow_path = $${params.push(workflow)} OR workflow_path LIKE $${params.push(`%/${workflow}`)})`);
      if (branch) where.push(`ref = $${params.push(`refs/heads/${branch}`)}`);
      const { rows } = await pool.query(
        `SELECT * FROM workflow_runs WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1`,
        params,
      );
      return rows[0] || null;
    },
    async listJobs(runId, { withLogs = false } = {}) {
      const cols = withLogs ? '*' : 'id, run_id, job_key, name, matrix, needs, image, status, conclusion, steps, started, finished';
      return (await pool.query(`SELECT ${cols} FROM workflow_jobs WHERE run_id = $1 ORDER BY id`, [runId])).rows;
    },
    async getJob(id) {
      return (await pool.query('SELECT * FROM workflow_jobs WHERE id = $1', [id])).rows[0] || null;
    },

    async setStatus(repoId, sha, context, state, description = '', targetUrl = '', ts = Date.now()) {
      await pool.query(
        `INSERT INTO commit_statuses (repo_id, sha, context, state, description, target_url, created, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (repo_id, sha, context)
         DO UPDATE SET state = EXCLUDED.state, description = EXCLUDED.description,
                       target_url = EXCLUDED.target_url, updated = EXCLUDED.updated`,
        [repoId, sha, String(context).slice(0, 255), state, String(description).slice(0, 1000), String(targetUrl).slice(0, 1000), ts],
      );
    },
    async listStatuses(repoId, sha) {
      return (
        await pool.query(
          'SELECT * FROM commit_statuses WHERE repo_id = $1 AND sha = $2 ORDER BY context',
          [repoId, sha],
        )
      ).rows;
    },

    async getSecrets(repoId) {
      return (await pool.query('SELECT key, value_enc FROM repo_secrets WHERE repo_id = $1', [repoId])).rows;
    },
    async openPrsForBranch(repoId, branch) {
      return (
        await pool.query(
          "SELECT * FROM pull_requests WHERE repo_id = $1 AND source_branch = $2 AND state = 'open'",
          [repoId, branch],
        )
      ).rows;
    },
    async findService(repoId, name) {
      return (
        await pool.query('SELECT * FROM deploy_services WHERE repo_id = $1 AND name = $2', [repoId, name])
      ).rows[0] || null;
    },
    async getDeployment(id) {
      return (await pool.query('SELECT * FROM deployments WHERE id = $1', [id])).rows[0] || null;
    },

    /**
     * Boot-time reconcile: anything not finished by this process was
     * interrupted by a restart. Returns the affected jobs so their commit
     * statuses can be closed.
     */
    async interruptUnfinished(activeRunIds, ts) {
      const ids = [...activeRunIds];
      const { rows: jobs } = await pool.query(
        `UPDATE workflow_jobs j SET status = 'completed', conclusion = 'failure',
                finished = coalesce(j.finished, $2)
           FROM workflow_runs r
          WHERE j.run_id = r.id AND j.status <> 'completed' AND NOT (r.id = ANY($1::bigint[]))
          RETURNING j.*, r.repo_id, r.sha, r.workflow_name, r.event, r.run_number`,
        [ids, ts],
      );
      await pool.query(
        `UPDATE workflow_runs SET status = 'completed', conclusion = 'failure',
                error = coalesce(error, 'Interrupted by a restart of nixre-core'), finished = coalesce(finished, $2)
          WHERE status <> 'completed' AND NOT (id = ANY($1::bigint[]))`,
        [ids, ts],
      );
      return jobs;
    },
  };
}

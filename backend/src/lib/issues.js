// Issue storage shared by the HTTP routes and the security scanner.

const MAX_TITLE = 200;
const MAX_BODY = 60_000;
const MAX_LABELS = 10;

export function cleanLabels(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const l of raw) {
    const s = String(l ?? '').trim().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
  }
  return out.slice(0, MAX_LABELS);
}

export function validateIssueInput({ title, body }) {
  const t = String(title ?? '').trim();
  if (!t) return { error: 'title is required' };
  if (t.length > MAX_TITLE) return { error: `title is limited to ${MAX_TITLE} characters` };
  const b = String(body ?? '');
  if (b.length > MAX_BODY) return { error: `body is limited to ${MAX_BODY} characters` };
  return { title: t, body: b };
}

/**
 * Insert an issue with the next per-repo number. The repo row lock serializes
 * concurrent creators, so two issues can never race to the same number.
 */
export async function createIssue(pool, { repoId, title, body, labels, authorUid, source = 'user', fingerprint = null }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM repos WHERE id = $1 FOR UPDATE', [repoId]);
    const { rows: [{ n }] } = await client.query(
      'SELECT coalesce(max(number), 0) + 1 AS n FROM issues WHERE repo_id = $1',
      [repoId],
    );
    const ts = Date.now();
    const { rows } = await client.query(
      `INSERT INTO issues (repo_id, number, title, body, labels, author_uid, source, fingerprint, created, updated)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$9) RETURNING *`,
      [repoId, n, title, body, JSON.stringify(cleanLabels(labels)), authorUid, source, fingerprint, ts],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function addComment(pool, { issueId, authorUid, body, source = 'user' }) {
  const ts = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO issue_comments (issue_id, author_uid, body, source, created)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [issueId, authorUid, body, source, ts],
  );
  await pool.query('UPDATE issues SET updated = $2 WHERE id = $1', [issueId, ts]);
  return rows[0];
}

export async function setIssueState(pool, issueId, state) {
  const ts = Date.now();
  const { rows } = await pool.query(
    `UPDATE issues SET state = $2, updated = $3, closed = $4 WHERE id = $1 RETURNING *`,
    [issueId, state, ts, state === 'closed' ? ts : null],
  );
  return rows[0];
}

async function authorsByUid(pool, uids) {
  const ids = [...new Set(uids.filter(Boolean))];
  if (!ids.length) return {};
  const { rows } = await pool.query('SELECT uid, display_name FROM users WHERE uid = ANY($1)', [ids]);
  return Object.fromEntries(rows.map(u => [u.uid, { uid: u.uid, display_name: u.display_name }]));
}

const author = (map, uid) => map[uid] ?? { uid, display_name: uid };

export async function issuesPublic(pool, rows) {
  const authors = await authorsByUid(pool, rows.map(r => r.author_uid));
  const counts = rows.length
    ? Object.fromEntries((await pool.query(
        'SELECT issue_id, count(*)::int AS n FROM issue_comments WHERE issue_id = ANY($1) GROUP BY issue_id',
        [rows.map(r => r.id)],
      )).rows.map(r => [String(r.issue_id), r.n]))
    : {};
  return rows.map(r => ({
    number: Number(r.number),
    title: r.title,
    body: r.body,
    state: r.state,
    labels: Array.isArray(r.labels) ? r.labels : [],
    source: r.source,
    author: author(authors, r.author_uid),
    created: Number(r.created),
    updated: Number(r.updated),
    ...(r.closed == null ? {} : { closed: Number(r.closed) }),
    comment_count: counts[String(r.id)] ?? 0,
  }));
}

export async function commentsPublic(pool, rows) {
  const authors = await authorsByUid(pool, rows.map(r => r.author_uid));
  return rows.map(r => ({
    id: Number(r.id),
    body: r.body,
    source: r.source,
    author: author(authors, r.author_uid),
    created: Number(r.created),
  }));
}

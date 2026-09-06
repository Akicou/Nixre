// Repository visibility — the single source of truth for "may this user read
// this repo?".
//
// This exists because the read endpoints used to each roll their own (mostly
// non-existent) check: the git Smart HTTP path enforced `is_public`, while the
// JSON API paths only checked that the repo row existed. Any authenticated
// user could therefore read every private repository on the instance.
//
// Every read of repo content — tree listings, raw blobs, commits, branches,
// diffs, and the assistant's read-only tools — must go through canReadRepo.

/**
 * Can `user` read the repo described by a repos row?
 *
 * Rules, in order:
 *   - instance admins read everything
 *   - public repos are world-readable
 *   - otherwise the caller must be a member of the owning space
 *   - blocked users read nothing
 *
 * @param {import('pg').Pool} pool
 * @param {{space_uid: string, is_public: boolean}} repo  a row from `repos`
 * @param {{uid: string, admin: boolean, blocked?: boolean}} user
 * @returns {Promise<boolean>}
 */
export async function canReadRepo(pool, repo, user) {
  if (!repo || !user) return false;
  if (user.blocked) return false;
  if (user.admin) return true;
  if (repo.is_public) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
    [repo.space_uid, user.uid],
  );
  return rows.length > 0;
}

/**
 * Convenience wrapper: load a repo by space/uid and check read access in one
 * step. Returns `{ repo }` or `{ error: { status, message } }` so callers can
 * respond without re-deriving the 404-vs-403 distinction.
 *
 * A caller with no read access gets 404, not 403 — a 403 would confirm that a
 * private repository with that name exists.
 */
export async function loadReadableRepo(pool, space, uid, user) {
  const { rows } = await pool.query(
    'SELECT * FROM repos WHERE space_uid = $1 AND uid = $2',
    [space, uid],
  );
  const repo = rows[0];
  if (!repo) return { error: { status: 404, message: 'Repository not found' } };
  if (!(await canReadRepo(pool, repo, user))) {
    return { error: { status: 404, message: 'Repository not found' } };
  }
  return { repo };
}

/**
 * Can `user` write to the repo? Membership in the owning space (or admin).
 * Kept beside canReadRepo so the pair is easy to audit together.
 */
export async function canWriteRepo(pool, repo, user) {
  if (!repo || !user) return false;
  if (user.blocked) return false;
  if (user.admin) return true;
  const { rows } = await pool.query(
    'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
    [repo.space_uid, user.uid],
  );
  return rows.length > 0;
}

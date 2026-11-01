// Extra commit emails an account has claimed (see migration 034). The primary
// email on `users` always counts too.

const EMAIL_RE = /^[^\s@<>]{1,64}@[^\s@<>]{1,255}$/;

export function normalizeEmail(raw) {
  const email = String(raw ?? '').trim().toLowerCase();
  return email.length <= 320 && EMAIL_RE.test(email) ? email : null;
}

export async function listEmails(pool, uid) {
  const { rows } = await pool.query('SELECT email, created FROM user_emails WHERE user_uid = $1 ORDER BY created', [uid]);
  return rows.map(r => ({ email: r.email, created: Number(r.created) }));
}

// Primary + claimed addresses, lowercased.
export async function allEmails(pool, user) {
  const claimed = await listEmails(pool, user.uid);
  return [...new Set([String(user.email).toLowerCase(), ...claimed.map(e => e.email)])];
}

// First claim wins. Returns { ok: true } or { ok: false, status, message }.
export async function claimEmail(pool, uid, raw, { override = false } = {}) {
  const email = normalizeEmail(raw);
  if (!email) return { ok: false, status: 400, message: 'Enter a valid email address' };
  const { rows: primary } = await pool.query('SELECT uid FROM users WHERE lower(email) = $1', [email]);
  if (primary.length && primary[0].uid !== uid) {
    return { ok: false, status: 409, message: 'That email is the sign-in address of another account' };
  }
  if (primary.length) return { ok: true, email }; // already ours as the primary
  if (override) {
    await pool.query(
      `INSERT INTO user_emails (email, user_uid, created) VALUES ($1, $2, $3)
       ON CONFLICT (email) DO UPDATE SET user_uid = EXCLUDED.user_uid`,
      [email, uid, Date.now()],
    );
    return { ok: true, email };
  }
  const { rows } = await pool.query(
    `INSERT INTO user_emails (email, user_uid, created) VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING RETURNING email`,
    [email, uid, Date.now()],
  );
  if (rows.length) return { ok: true, email };
  const { rows: owner } = await pool.query('SELECT user_uid FROM user_emails WHERE email = $1', [email]);
  if (owner[0]?.user_uid === uid) return { ok: true, email };
  return { ok: false, status: 409, message: 'That email is already claimed by another account' };
}

// email (lowercase) -> uid for every claimed address.
export async function claimedOwners(pool) {
  const { rows } = await pool.query('SELECT email, user_uid FROM user_emails');
  return new Map(rows.map(r => [r.email, r.user_uid]));
}

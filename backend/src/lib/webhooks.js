// Webhook delivery — HMAC-signed payloads with retry + exponential backoff.
//
// Delivery is fire-and-forget from the route handlers' perspective: rows are
// queued in webhook_deliveries and a sweep() call attempts pending ones.
// The sweep also runs opportunistically on every fire (no separate worker
// process needed for the self-hosted scale this targets).

import crypto from 'node:crypto';
import { guardedFetch } from './netGuard.js';
import { decryptSecret } from './ai.js';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [0, 15_000, 60_000, 300_000, 1_800_000];

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * The HMAC key for a delivery row.
 *
 * Two storage formats coexist and this is the single place that reconciles
 * them:
 *   - rows written from this version on: ciphertext in `secret_enc`, '' in
 *     `secret` — decrypt to get the key;
 *   - rows written before migration 025: plaintext in `secret`, NULL in
 *     `secret_enc` — SQL cannot run AES-GCM, so the migration deliberately
 *     left them alone.
 *
 * Getting this wrong is silent: a bad key still produces a well-formed
 * signature header, and the receiver simply rejects every delivery.
 *
 * @returns {string} the signing key ('' when nothing is stored)
 */
export function signingSecretFor(row) {
  if (!row) return '';
  if (row.secret_enc) {
    const decrypted = decryptSecret(row.secret_enc);
    if (decrypted != null) return decrypted;
    // Fall through: if decryption fails, the legacy column may still hold it.
  }
  return row.secret ?? '';
}

// Queue + attempt deliveries for a repo event. Returns queued delivery rows.
export async function fireWebhooks(pool, space, repo, event) {
  const { rows: repos } = await pool.query(
    'SELECT id FROM repos WHERE space_uid = $1 AND uid = $2',
    [space, repo],
  );
  if (repos.length === 0) return [];
  const repoId = repos[0].id;

  const { rows: hooks } = await pool.query(
    `SELECT * FROM repo_webhooks
     WHERE repo_id = $1 AND active = TRUE AND $2 = ANY (events)`,
    [repoId, event.type],
  );
  if (hooks.length === 0) return [];

  const payload = {
    repository: { path: `${space}/${repo}` },
    event: event.type,
    ...event,
    timestamp: Date.now(),
  };

  const queued = [];
  for (const hook of hooks) {
    const { rows } = await pool.query(
      `INSERT INTO webhook_deliveries (webhook_id, event_type, payload, created, next_retry)
       VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING *`,
      [hook.id, event.type, JSON.stringify(payload), Date.now()],
    );
    queued.push(rows[0]);
  }
  // Attempt immediately; failures keep their next_retry for the sweep.
  await sweep(pool);
  return queued;
}

// Attempt every due delivery; exponential backoff up to MAX_ATTEMPTS.
export async function sweep(pool) {
  const { rows: due } = await pool.query(
    `SELECT d.*, w.url, w.secret, w.secret_enc FROM webhook_deliveries d
     JOIN repo_webhooks w ON w.id = d.webhook_id
     WHERE d.next_retry IS NOT NULL AND d.next_retry <= $1
     LIMIT 25`,
    [Date.now()],
  );

  for (const d of due) {
    const body = JSON.stringify(d.payload);
    const secret = signingSecretFor(d);
    let statusCode = null;
    let ok = false;
    let lastError = null;
    try {
      // guardedFetch resolves the host and refuses loopback, link-local
      // (cloud metadata), RFC1918 and docker-internal targets, and
      // re-validates every redirect hop. A webhook URL is user-supplied, so
      // without this it is a server-side request forgery primitive.
      const r = await guardedFetch(
        d.url,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Nixre-Event': d.event_type,
            'X-Nixre-Signature': sign(secret, body),
            'X-Nixre-Delivery': String(d.id),
          },
          body,
        },
        { timeoutMs: 10_000 },
      );
      statusCode = r.status;
      ok = r.ok;
    } catch (err) {
      ok = false;
      lastError = err.message;
    }
    // A URL that is refused outright can never succeed, so stop retrying it
    // instead of hammering a blocked target five times.
    const blocked = !ok && /[Rr]efusing|Not a valid URL|Only http\(s\)|Could not resolve|credentials/.test(
      lastError || '',
    );

    const attempts = d.attempts + 1;
    const done = ok || blocked || attempts >= MAX_ATTEMPTS;
    const nextRetry = done ? null : Date.now() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
    await pool.query(
      `UPDATE webhook_deliveries
       SET status_code = $2, ok = $3, attempts = $4,
           delivered = CASE WHEN $3 THEN $5 ELSE delivered END,
           next_retry = $6,
           error = $7
       WHERE id = $1`,
      [d.id, statusCode, ok, attempts, Date.now(), nextRetry, ok ? null : lastError],
    );
  }
}

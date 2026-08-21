// Webhook delivery — HMAC-signed payloads with retry + exponential backoff.
//
// Delivery is fire-and-forget from the route handlers' perspective: rows are
// queued in webhook_deliveries and a sweep() call attempts pending ones.
// The sweep also runs opportunistically on every fire (no separate worker
// process needed for the self-hosted scale this targets).

import crypto from 'node:crypto';

const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [0, 15_000, 60_000, 300_000, 1_800_000];

function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
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
    `SELECT d.*, w.url, w.secret FROM webhook_deliveries d
     JOIN repo_webhooks w ON w.id = d.webhook_id
     WHERE d.next_retry IS NOT NULL AND d.next_retry <= $1
     LIMIT 25`,
    [Date.now()],
  );

  for (const d of due) {
    const body = JSON.stringify(d.payload);
    let statusCode = null;
    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      const r = await fetch(d.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Nixre-Event': d.event_type,
          'X-Nixre-Signature': sign(d.secret, body),
          'X-Nixre-Delivery': String(d.id),
        },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      statusCode = r.status;
      ok = r.ok;
    } catch {
      ok = false;
    }

    const attempts = d.attempts + 1;
    const done = ok || attempts >= MAX_ATTEMPTS;
    const nextRetry = done ? null : Date.now() + RETRY_DELAYS_MS[Math.min(attempts, RETRY_DELAYS_MS.length - 1)];
    await pool.query(
      `UPDATE webhook_deliveries
       SET status_code = $2, ok = $3, attempts = $4,
           delivered = CASE WHEN $3 THEN $5 ELSE delivered END,
           next_retry = $6
       WHERE id = $1`,
      [d.id, statusCode, ok, attempts, Date.now(), nextRetry],
    );
  }
}

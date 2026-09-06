// Webhook signing-key selection and SSRF rejection.
//
// Regression: adding `secret_enc` introduced two ways to get this wrong —
// the migration copying plaintext into the encrypted column (so decryption
// fails), and the signer reading the now-empty legacy column. Either one
// produces well-formed signatures that every receiver rejects, which fails
// silently rather than loudly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signingSecretFor, sweep } from '../lib/webhooks.js';
import { encryptSecret } from '../lib/ai.js';

// Use a real key so encrypt/decrypt round-trips.
process.env.AI_SECRET = 'test-ai-secret-for-webhook-signing-0123456789abcdef';

test('signingSecretFor decrypts the encrypted column', () => {
  const row = { secret: '', secret_enc: encryptSecret('s3cr3t-key') };
  assert.equal(signingSecretFor(row), 's3cr3t-key');
});

test('signingSecretFor falls back to legacy plaintext', () => {
  // Rows written before migration 025 keep the plaintext in `secret`.
  const row = { secret: 'legacy-plaintext', secret_enc: null };
  assert.equal(signingSecretFor(row), 'legacy-plaintext');
  assert.equal(signingSecretFor({ secret: 'legacy-plaintext' }), 'legacy-plaintext');
});

test('signingSecretFor never returns undefined for empty rows', () => {
  assert.equal(signingSecretFor(null), '');
  assert.equal(signingSecretFor({}), '');
  assert.equal(signingSecretFor({ secret: '', secret_enc: '' }), '');
});

test('signingSecretFor prefers the encrypted value when both are present', () => {
  const row = { secret: 'stale-plaintext', secret_enc: encryptSecret('current-key') };
  assert.equal(signingSecretFor(row), 'current-key');
});

// --- SSRF: a blocked target must be marked done, not retried -----------------

test('sweep records a policy refusal and stops retrying', async () => {
  const updates = [];
  const pool = {
    async query(sql, params) {
      if (/FROM webhook_deliveries d/.test(sql)) {
        return {
          rows: [
            {
              id: 1,
              attempts: 0,
              event_type: 'push',
              payload: { a: 1 },
              // Loopback is refused by the SSRF guard without any network call.
              url: 'http://127.0.0.1:9/hook',
              secret: '',
              secret_enc: null,
            },
          ],
        };
      }
      updates.push({ sql, params });
      return { rows: [] };
    },
  };

  await sweep(pool);

  assert.equal(updates.length, 1, 'the delivery row should be updated once');
  const [, statusCode, ok, attempts, , nextRetry, error] = updates[0].params;
  assert.equal(ok, false);
  assert.equal(attempts, 1);
  assert.equal(nextRetry, null, 'a refused URL must not be retried');
  assert.equal(statusCode, null, 'no HTTP status was obtained');
  assert.match(String(error), /[Rr]efusing|private|loopback/);
});

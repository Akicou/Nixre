// Encrypted per-user third-party secrets (GitHub PAT, later others).
// Blobs use the same AES-256-GCM format as AI provider keys.

import { pool } from '../db/pool.js';
import { decryptSecret } from './ai.js';

export async function getDecryptedSecret(uid, kind) {
  if (!uid || !kind) return null;
  const { rows } = await pool.query(
    'SELECT secret_enc FROM user_secrets WHERE user_uid = $1 AND kind = $2',
    [uid, kind],
  );
  if (!rows[0]?.secret_enc) return null;
  return decryptSecret(rows[0].secret_enc);
}

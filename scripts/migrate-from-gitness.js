#!/usr/bin/env node
// One-time migration from a legacy Gitness instance to sovereign Nixre.
//
// Usage:
//   node scripts/migrate-from-gitness.js http://old-gitness:3000 <admin-token>
//   (or set GITNESS_URL / GITNESS_TOKEN env vars)
//
// What migrates:
//   * spaces  -> spaces rows (creator = the admin running the migration)
//   * repos   -> repos rows + bare mirrors (git clone --mirror: full
//                history, branches, tags preserved)
//   * users   -> re-registration is required (passwords cannot be exported);
//                re-register with the same uid to re-own migrated content
// What does NOT migrate:
//   * pull requests (Gitness PR history stays behind)
//   * CI pipelines, webhooks, connectors

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';

const exec = promisify(execFile);

const GITNESS = process.argv[2] || process.env.GITNESS_URL || 'http://127.0.0.1:3001';
const TOKEN = process.argv[3] || process.env.GITHUB_TOKEN || process.env.GITNESS_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://nixre:nixre@127.0.0.1:5432/nixre';
const REPOS_ROOT = process.env.REPOS_ROOT || './data/repos';

if (!TOKEN) {
  console.error('Provide the old admin token: node migrate-from-gitness.js <url> <token>');
  process.exit(1);
}

async function gitness(path) {
  const r = await fetch(`${GITNESS}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const me = await gitness('/user');
  const adminUid = me.uid;
  const ts = Date.now();

  // --- spaces ---
  const spaces = await gitness('/spaces');
  const spaceList = spaces || [];
  const spaceIds = new Map();

  for (const s of spaceList) {
    const uid = s.uid || s.identifier;
    const { rows } = await pool.query(
      `INSERT INTO spaces (uid, description, is_public, created_by, created, updated)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (uid) DO UPDATE SET description = EXCLUDED.description
       RETURNING uid`,
      [uid, s.description || '', Boolean(s.is_public), adminUid, Number(s.created) || ts],
    );
    spaceIds.set(s.id, uid);
    await pool.query(
      `INSERT INTO space_members (space_uid, user_uid, role, created)
       VALUES ($1, $2, 'owner', $3)
       ON CONFLICT DO NOTHING`,
      [uid, adminUid, ts],
    );
    console.log(`space  ${uid}`);
  }

  // --- repos (mirror the git content) ---
  let migrated = 0;
  for (const [, spaceUid] of spaceIds) {
    const repos = (await gitness(`/spaces/${spaceUid}/repos`)) || [];
    for (const r of repos) {
      const uid = r.uid || r.identifier;
      const cloneUrl = `${GITNESS}/git/${spaceUid}/${uid}.git`;
      const dir = `${REPOS_ROOT}/${spaceUid}/${uid}.git`;
      await exec('mkdir', ['-p', `${REPOS_ROOT}/${spaceUid}`]);
      try {
        await exec('git', [
          '-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`,
          'clone', '--mirror', cloneUrl, dir,
        ], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        await exec('git', ['-C', dir, 'config', 'http.receivepack', 'true']);
      } catch (err) {
        console.error(`repo   ${spaceUid}/${uid}: clone failed (${err.message.split('\n')[0]}) — skipped`);
        continue;
      }
      // default branch from the mirror
      let defaultBranch = 'main';
      try {
        const { stdout } = await exec('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
        defaultBranch = stdout.trim() || 'main';
      } catch {}
      await pool.query(
        `INSERT INTO repos (space_uid, uid, description, is_public, default_branch, created_by, created, updated)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
         ON CONFLICT (space_uid, uid) DO NOTHING`,
        [spaceUid, uid, r.description || '', r.is_public !== false, defaultBranch, adminUid, Number(r.created) || ts],
      );
      console.log(`repo   ${spaceUid}/${uid} (default: ${defaultBranch})`);
      migrated++;
    }
  }

  console.log(`\nDone: ${spaceList.length} space(s), ${migrated} repo(s) migrated.`);
  console.log('Users must re-register (same uid re-owns content after an admin adds them to spaces).');
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});

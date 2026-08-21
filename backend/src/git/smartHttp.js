// Git Smart HTTP transport — /git/{space}/{repo}.git served by
// `git http-backend` (CGI) with core authentication.
//
// Auth: HTTP Basic (`username:token`). The token is resolved against core
// sessions/PATs (same middleware path as the API). Authorization:
//   read  (clone/fetch) - public repo, or space member, or admin
//   write (push)        - space member or admin
//
// The CGI handshake is streamed both ways so pack negotiation (which can be
// large) never buffers in memory.

import { spawn } from 'node:child_process';
import { findRepo } from '../routes/forge.js';
import { repoExists } from './repo.js';

function writeChunk(res, buf) {
  return new Promise(resolve => res.write(buf, resolve));
}

// Minimal, correct-enough CGI response parser: splits headers from body on
// the first \r\n\r\n and supports chunked pass-through after that.
export function smartHttp(pool, authenticate) {
  return async (req, res) => {
    // req.url is rebased inside a mounted router; originalUrl keeps /git.
    const url = new URL(req.originalUrl, 'http://internal');
    // Path shape: /git/{space}/{repo}.git[/{service}]
    const match = url.pathname.match(/^\/git\/([^/]+)\/([^/]+?)(?:\.git)?(\/.*)?$/);
    if (!match) {
      res.status(400).send('bad git path');
      return;
    }
    const [, space, repoUid, tail] = match;
    const service = (tail || '').replace(/^\//, '');

    // --- authentication (Basic) ---------------------------------------------
    let user = null;
    let authKind = null;
    const authHeader = req.headers.authorization || '';
    if (authHeader.startsWith('Basic ')) {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx > 0) {
        const token = decoded.slice(idx + 1);
        const { resolveBearer } = await import('../lib/auth.js');
        const resolved = await resolveBearer(pool, token);
        if (resolved) {
          user = resolved.user;
          authKind = resolved.kind;
        }
      }
    }
    if (!user) {
      res.setHeader('WWW-Authenticate', 'Basic realm="nixre-git"');
      res.status(401).send('authentication required');
      return;
    }

    // --- authorization --------------------------------------------------------
    const repo = await findRepo(pool, `${space}/${repoUid}`);
    if (!repo || !(await repoExists(space, repoUid))) {
      res.status(404).send('repository not found');
      return;
    }
    let member = user.admin;
    if (!member) {
      const { rows } = await pool.query(
        'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
        [repo.space_uid, user.uid],
      );
      member = rows.length > 0;
    }
    const isPush = service === 'git-receive-pack' || req.method === 'POST' && service === 'git-receive-pack';
    if (isPush && !member) {
      res.status(403).send('no write access');
      return;
    }
    if (!repo.is_public && !member) {
      res.status(403).send('no read access');
      return;
    }
    void authenticate;
    void authKind;

    // --- run git http-backend (CGI) -------------------------------------------
    const pathInfo = `/${space}/${repoUid}.git${service ? `/${service}` : ''}`;
    const env = {
      GIT_PROJECT_ROOT: process.env.REPOS_ROOT || '/data/repos',
      GIT_HTTP_EXPORT_ALL: '1',
      PATH_INFO: pathInfo,
      REQUEST_METHOD: req.method,
      QUERY_STRING: url.searchParams.toString(),
      CONTENT_TYPE: req.headers['content-type'] || '',
      CONTENT_LENGTH: String(req.headers['content-length'] || ''),
      REMOTE_USER: user.uid,
      REMOTE_ADDR: req.socket.remoteAddress || '',
      GIT_COMMITTER_NAME: user.display_name || user.uid,
      GIT_COMMITTER_EMAIL: user.email,
    };

    const cgi = spawn('git', ['http-backend'], { env: { ...process.env, ...env } });
    req.pipe(cgi.stdin);

    // Parse CGI headers from the first chunk, then stream the rest.
    let headerBuf = Buffer.alloc(0);
    let headersDone = false;
    let status = 200;
    const headerLines = [];

    cgi.stdout.on('data', async chunk => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const sep = headerBuf.indexOf('\r\n\r\n');
      if (sep === -1) return;
      const headerText = headerBuf.slice(0, sep).toString('utf8');
      const body = headerBuf.slice(sep + 4);
      for (const line of headerText.split('\r\n')) {
        const colon = line.indexOf(':');
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const value = line.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') {
          status = parseInt(value, 10) || 200;
        } else {
          headerLines.push([name, value]);
        }
      }
      res.writeHead(status, Object.fromEntries(headerLines));
      headersDone = true;
      if (body.length > 0) await writeChunk(res, body);
    });

    cgi.stderr.on('data', d => console.error('[git-http]', d.toString().trim()));
    cgi.on('close', () => {
      if (!headersDone) {
        res.status(500).end('git http-backend failed');
      } else {
        res.end();
      }
    });
    req.on('error', () => cgi.kill());
  };
}

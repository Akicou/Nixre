// Git Smart HTTP transport — /git/{space}/{repo}.git served by
// `git http-backend` (CGI) with core authentication.
//
// Auth: HTTP Basic (`username:token`). The token is resolved against core
// sessions/PATs (same middleware path as the API). Authorization:
//   read  (clone/fetch) - public repo (no auth needed), or space member/admin
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
    const serviceFromQuery = url.searchParams.get('service') || '';
    // Write = git-receive-pack (the hint is in the tail for the POST, or in
    // the `service=` query param on the leading info/refs request during push).
    const isWrite = service === 'git-receive-pack' || serviceFromQuery === 'git-receive-pack';

    // Look up the repo first — we need its visibility to decide whether an
    // anonymous read is allowed before we require credentials.
    const repo = await findRepo(pool, `${space}/${repoUid}`);
    if (!repo || !(await repoExists(space, repoUid))) {
      res.status(404).send('repository not found');
      return;
    }

    // --- optional authentication (Basic) --------------------------------------
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

    // --- authorization --------------------------------------------------------
    let member = false;
    if (user) {
      member = user.admin;
      if (!member) {
        const { rows } = await pool.query(
          'SELECT 1 FROM space_members WHERE space_uid = $1 AND user_uid = $2',
          [repo.space_uid, user.uid],
        );
        member = rows.length > 0;
      }
    }

    // Writes always require a member/admin. Reads on public repos are open
    // to everyone (no credentials); private reads still need a member/admin.
    if (isWrite) {
      if (!user) {
        res.setHeader('WWW-Authenticate', 'Basic realm="nixre-git"');
        res.status(401).send('authentication required');
        return;
      }
      if (!member) {
        res.status(403).send('no write access');
        return;
      }
    } else if (!repo.is_public && !member) {
      if (!user) {
        res.setHeader('WWW-Authenticate', 'Basic realm="nixre-git"');
        res.status(401).send('authentication required');
      } else {
        res.status(403).send('no read access');
      }
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
      REMOTE_USER: user ? user.uid : 'anonymous',
      REMOTE_ADDR: req.socket.remoteAddress || '',
      GIT_COMMITTER_NAME: (user && (user.display_name || user.uid)) || 'anonymous',
      GIT_COMMITTER_EMAIL: (user && user.email) || '',
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
        // Push webhook fanout is handled by the bare repo's post-receive
        // hook (fires for both HTTP and SSH pushes).
      }
    });
    req.on('error', () => cgi.kill());
  };
}

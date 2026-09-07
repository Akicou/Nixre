import http from 'node:http';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';

const directory = process.env.NIXRE_UPDATE_CONTROL_DIR || '/data/update-control';
export async function callUpdater(operation, body) {
  const key = (await readFile(path.join(directory, 'key'), 'utf8')).trim();
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path.join(directory, 'control.sock'), path: operation,
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 1024 * 1024) req.destroy(new Error('Updater response too large.')); });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(text);
          if (res.statusCode >= 400) reject(Object.assign(new Error(result.message || 'Updater rejected the request.'), { status: res.statusCode }));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('Updater did not respond. Reconnect to check whether the request was accepted.')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export function updateMaintenance(controlDirectory = directory) {
  return async (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    try { await access(path.join(controlDirectory, 'maintenance.json')); }
    catch (error) { if (error.code === 'ENOENT') return next(); }
    res.set('Retry-After', '30').status(503).json({ message: 'An instance update is in progress. Writes are temporarily paused; follow the update progress page.' });
  };
}

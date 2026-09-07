import express from 'express';
import { callUpdater } from '../lib/instanceUpdater.js';

export function updateRoutes(authenticate, call = callUpdater) {
  const router = express.Router();
  router.use('/admin/updates', authenticate(true), (req, res, next) => {
    if (!req.auth?.user?.admin || req.auth.user.blocked || req.auth.kind !== 'session') {
      return res.status(403).json({ message: 'An administrator browser session is required.' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  });
  const handle = operation => async (req, res) => {
    const mutation = operation !== '/state';
    if (mutation && !/^[a-f0-9-]{36}$/.test(req.body?.requestId || '')) return res.status(400).json({ message: 'A request id is required.' });
    try {
      const result = await call(operation, mutation ? {
        requestId: req.body.requestId, actor: req.auth.user.uid,
        ...(operation === '/apply' ? { planId: req.body.planId, target: req.body.target, expectedBase: req.body.expectedBase } : {}),
      } : undefined);
      res.status(mutation ? 202 : 200).json(result);
    } catch (error) {
      if (!mutation && ['ENOENT', 'ECONNREFUSED'].includes(error.code)) return res.json({ enabled: false, message: 'Install the host updater once to enable safe updates. See docs/instance-updates.md.' });
      res.status(error.status || 503).json({ message: error.status ? error.message : 'Updater unavailable. Reconnect to check the last request; do not assume it failed.' });
    }
  };
  router.get('/admin/updates', handle('/state'));
  router.post('/admin/updates/check', handle('/check'));
  router.post('/admin/updates/apply', handle('/apply'));
  return router;
}

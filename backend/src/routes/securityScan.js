// Admin API for the built-in security scanner.

import express from 'express';
import { isScanRunning, loadScanSettings, runSecurityScan, saveScanSettings } from '../lib/securityScanRun.js';

const runPublic = r => ({
  id: Number(r.id),
  started: Number(r.started),
  finished: r.finished == null ? null : Number(r.finished),
  status: r.status,
  trigger: r.trigger_kind,
  summary: r.summary,
  error: r.error,
  findings: r.findings,
  issues_created: r.issues_created,
  report: r.report ?? null,
});

export function securityScanRoutes(pool, authenticate) {
  const api = express.Router();
  const admin = [authenticate(true), (req, res, next) => {
    if (!req.auth?.user?.admin) return res.status(403).json({ message: 'Admin access required' });
    next();
  }];

  async function state(uid) {
    const settings = await loadScanSettings(pool);
    const { rows: providers } = await pool.query(
      'SELECT id, label, provider, default_model, enabled_models FROM ai_providers WHERE user_uid = $1 ORDER BY created', [uid],
    );
    // Reports are fetched per run; the list stays light.
    const { rows: runs } = await pool.query(
      `SELECT id, started, finished, status, trigger_kind, summary, error, findings, issues_created
       FROM security_scans ORDER BY id DESC LIMIT 30`,
    );
    return {
      settings: {
        enabled: settings.enabled, intervalHours: settings.intervalHours,
        providerId: settings.providerId, model: settings.model, coreRepo: settings.coreRepo,
      },
      providers: providers.map(p => ({
        id: Number(p.id), label: p.label, provider: p.provider, defaultModel: p.default_model,
        models: [...new Set([p.default_model, ...(p.enabled_models ?? [])].filter(Boolean))],
      })),
      running: isScanRunning(),
      // null while a scan runs or scheduling is off. The scheduler ticks once a minute, so the real start can trail this by up to 60s.
      nextRunAt: !settings.enabled || isScanRunning() ? null
        : runs[0] ? Number(runs[0].started) + Math.max(1, Number(settings.intervalHours) || 3) * 3_600_000 : Date.now(),
      runs: runs.map(runPublic),
    };
  }

  api.get('/admin/security-scan', ...admin, async (req, res) => res.json(await state(req.auth.user.uid)));

  api.put('/admin/security-scan', ...admin, async (req, res) => {
    const b = req.body ?? {};
    const intervalHours = Number(b.intervalHours);
    if (!Number.isInteger(intervalHours) || intervalHours < 1 || intervalHours > 168) {
      return res.status(400).json({ message: 'intervalHours must be a whole number from 1 to 168' });
    }
    const coreRepo = String(b.coreRepo ?? '').trim();
    if (coreRepo) {
      const [space, uid, ...rest] = coreRepo.split('/');
      const { rows } = rest.length || !space || !uid ? { rows: [] }
        : await pool.query('SELECT 1 FROM repos WHERE space_uid = $1 AND uid = $2', [space, uid]);
      if (!rows[0]) return res.status(400).json({ message: `coreRepo '${coreRepo}' is not a repository on this instance` });
    }
    let providerId = null;
    let model = '';
    if (b.providerId != null && b.providerId !== '') {
      providerId = Number(b.providerId);
      const { rows } = await pool.query('SELECT id FROM ai_providers WHERE id = $1 AND user_uid = $2', [providerId, req.auth.user.uid]);
      if (!rows[0]) return res.status(400).json({ message: 'providerId is not one of your AI providers' });
      model = String(b.model ?? '').slice(0, 200);
    }
    await saveScanSettings(pool, {
      enabled: Boolean(b.enabled), intervalHours, providerId, model, coreRepo,
      userUid: providerId ? req.auth.user.uid : '',
    });
    res.json(await state(req.auth.user.uid));
  });

  api.post('/admin/security-scan/run', ...admin, (_req, res) => {
    if (isScanRunning()) return res.status(409).json({ message: 'A scan is already running' });
    void runSecurityScan({ pool, trigger: 'manual', force: true }).catch(err => console.error('security scan failed:', err.message));
    res.status(202).json({ started: true });
  });

  api.get('/admin/security-scan/runs/:id', ...admin, async (req, res) => {
    const id = Number(req.params.id);
    const { rows } = Number.isSafeInteger(id) ? await pool.query('SELECT * FROM security_scans WHERE id = $1', [id]) : { rows: [] };
    if (!rows[0]) return res.status(404).json({ message: 'Scan not found' });
    res.json(runPublic(rows[0]));
  });

  return api;
}

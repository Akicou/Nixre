// AI routes — multi-provider management, per-provider model lists, and a
// streaming chat proxy. Keys never leave the server.
//
// Model flow: each provider row caches the full live model list
// (`model_cache`, refreshed on demand) and the user enables a subset
// (`enabled_models`) that appears in chat pickers. Chat resolves the
// provider that owns the selected model.

import express from 'express';
import {
  PROVIDERS,
  listModels,
  streamChat,
  encryptSecret,
  decryptSecret,
  maskSecret,
  AuthError,
} from '../lib/ai.js';
import { TOOL_SCHEMAS, executeTool } from '../lib/agentTools.js';

const MODEL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function rowToProvider(row) {
  const def = PROVIDERS[row.provider] ?? PROVIDERS.custom;
  const cache = Array.isArray(row.model_cache) ? row.model_cache : [];
  const enabled = Array.isArray(row.enabled_models) ? row.enabled_models : [];
  return {
    id: Number(row.id),
    label: row.label,
    provider: row.provider,
    providerLabel: def.label,
    baseUrl: row.base_url || def.defaultBase || '',
    keyConfigured: Boolean(row.api_key_enc) || def.local === true,
    keyMask: row.key_mask || null,
    validatedAt: row.validated_at == null ? null : Number(row.validated_at),
    defaultModel: row.default_model || '',
    models: cache,           // everything the provider offers (cached)
    enabledModels: enabled,  // the user's picked subset for chat
    isDefault: Boolean(row.is_default),
    created: Number(row.created),
    updated: Number(row.updated),
  };
}

async function listRows(pool, uid) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_providers WHERE user_uid = $1 ORDER BY created',
    [uid],
  );
  return rows;
}

// One-time migration from the 007 single-profile table.
async function migrateLegacy(pool, uid) {
  const existing = await pool.query(
    'SELECT count(*)::int AS n FROM ai_providers WHERE user_uid = $1',
    [uid],
  );
  if (existing.rows[0].n > 0) return;

  const { rows } = await pool.query(
    'SELECT * FROM ai_provider_profiles WHERE user_uid = $1',
    [uid],
  );
  const legacy = rows[0];
  if (!legacy || !legacy.api_key_enc) return;

  const def = PROVIDERS[legacy.provider] ?? PROVIDERS.custom;
  const cache = Array.isArray(legacy.model_cache) ? legacy.model_cache : [];
  const now = Date.now();
  await pool.query(
    `INSERT INTO ai_providers
       (user_uid, label, provider, base_url, api_key_enc, key_mask, validated_at,
        default_model, model_cache, model_cache_at, enabled_models, is_default, created, updated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$9::jsonb,TRUE,$11,$11)`,
    [
      uid,
      def.label || legacy.provider,
      legacy.provider,
      legacy.base_url,
      legacy.api_key_enc,
      legacy.key_mask,
      legacy.validated_at,
      legacy.model,
      JSON.stringify(cache),
      legacy.model_cache_at,
      now,
    ],
  );
}

// Resolve the provider row a chat request should use: the default, or the
// one whose enabled/default models contain the requested model.
async function resolveForChat(pool, uid, model) {
  const rows = await listRows(pool, uid);
  if (rows.length === 0) return null;
  if (model) {
    const owner = rows.find(
      r =>
        (Array.isArray(r.enabled_models) && r.enabled_models.includes(model)) ||
        r.default_model === model,
    );
    if (owner) return owner;
  }
  return rows.find(r => r.is_default) ?? rows[0];
}

async function fetchAndCacheModels(pool, row, apiKey) {
  const models = await listModels(row.provider, apiKey, row.base_url);
  await pool.query(
    'UPDATE ai_providers SET model_cache = $2::jsonb, model_cache_at = $3, updated = $4 WHERE id = $1',
    [row.id, JSON.stringify(models), Date.now(), Date.now()],
  );
  return models;
}

export function aiRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // --- provider CRUD ----------------------------------------------------------

  // GET /ai/providers — all configured providers (no secrets).
  api.get('/ai/providers', auth, async (req, res) => {
    await migrateLegacy(pool, req.auth.user.uid);
    const rows = await listRows(pool, req.auth.user.uid);
    res.json(rows.map(rowToProvider));
  });

  // POST /ai/providers {label, provider, baseUrl?, apiKey, defaultModel?}
  // The key is validated against the live provider before storing; the
  // response carries the fetched model list.
  api.post('/ai/providers', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const label = String(req.body?.label || '').trim() || (PROVIDERS[String(req.body?.provider)]?.label ?? 'Provider');
    const provider = String(req.body?.provider || 'deepseek');
    const def = PROVIDERS[provider];
    if (!def) {
      res.status(400).json({ message: `Unknown provider '${provider}'` });
      return;
    }
    const baseUrl = String(req.body?.baseUrl || '').trim() || null;
    if (def.needsBaseUrl && !baseUrl) {
      res.status(400).json({ message: 'A base URL is required for custom providers' });
      return;
    }
    const apiKey = String(req.body?.apiKey || '').trim();
    if (!apiKey && def.local !== true) {
      res.status(400).json({ message: 'An API key is required' });
      return;
    }

    const dup = await pool.query(
      'SELECT id FROM ai_providers WHERE user_uid = $1 AND lower(label) = lower($2)',
      [uid, label],
    );
    if (dup.rows.length > 0) {
      res.status(409).json({ message: `A provider named '${label}' already exists` });
      return;
    }

    // Validate + fetch models up front.
    let modelCache = [];
    let validatedAt = null;
    try {
      modelCache = await listModels(provider, apiKey || null, baseUrl);
      validatedAt = Date.now();
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(400).json({ message: `Validation failed: ${err.message}` });
        return;
      }
      res.status(502).json({ message: `Could not reach the provider: ${err.message}` });
      return;
    }

    const now = Date.now();
    const anyRows = await pool.query(
      'SELECT count(*)::int AS n FROM ai_providers WHERE user_uid = $1',
      [uid],
    );
    const isDefault = anyRows.rows[0].n === 0; // first provider becomes active

    const { rows } = await pool.query(
      `INSERT INTO ai_providers
         (user_uid, label, provider, base_url, api_key_enc, key_mask, validated_at,
          default_model, model_cache, model_cache_at, enabled_models, is_default, created, updated)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$13) RETURNING *`,
      [
        uid, label, provider, baseUrl,
        apiKey ? encryptSecret(apiKey) : null,
        apiKey ? maskSecret(apiKey) : null,
        validatedAt,
        String(req.body?.defaultModel || modelCache[0] || ''),
        JSON.stringify(modelCache), now,
        JSON.stringify(modelCache.slice(0, 5)), // sensible initial subset
        isDefault, now,
      ],
    );
    res.status(201).json(rowToProvider(rows[0]));
  });

  // PATCH /ai/providers/:id — update label / baseUrl / apiKey (re-validates)
  // / enabledModels / defaultModel / isDefault.
  api.patch('/ai/providers/:id', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const { rows } = await pool.query(
      'SELECT * FROM ai_providers WHERE id = $1 AND user_uid = $2',
      [Number(req.params.id), uid],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Provider not found' });
      return;
    }

    const label = req.body?.label !== undefined ? String(req.body.label).trim() : row.label;
    const baseUrl = req.body?.baseUrl !== undefined ? String(req.body.baseUrl).trim() || null : row.base_url;
    const enabledModels = Array.isArray(req.body?.enabledModels)
      ? req.body.enabledModels.filter(m => typeof m === 'string')
      : row.enabled_models;
    const defaultModel = req.body?.defaultModel !== undefined ? String(req.body.defaultModel) : row.default_model;
    const apiKey = typeof req.body?.apiKey === 'string' && req.body.apiKey.length > 0
      ? req.body.apiKey.trim()
      : null;

    let apiKeyEnc = row.api_key_enc;
    let keyMask = row.key_mask;
    let validatedAt = row.validated_at;
    let modelCache = row.model_cache;

    const endpointChanged = req.body?.baseUrl !== undefined && baseUrl !== row.base_url;
    if (apiKey || (endpointChanged && row.api_key_enc)) {
      const effectiveKey = apiKey ?? decryptSecret(row.api_key_enc);
      try {
        modelCache = await fetchAndCacheModels(pool, { ...row, provider: row.provider, base_url: baseUrl }, effectiveKey);
        await pool.query('UPDATE ai_providers SET validated_at = $2 WHERE id = $1', [row.id, Date.now()]);
        validatedAt = Date.now();
      } catch (err) {
        if (err instanceof AuthError) {
          res.status(400).json({ message: `Validation failed: ${err.message}` });
          return;
        }
        res.status(502).json({ message: `Could not reach the provider: ${err.message}` });
        return;
      }
      if (apiKey) {
        apiKeyEnc = encryptSecret(apiKey);
        keyMask = maskSecret(apiKey);
      }
    }

    // Exactly-one-default invariant.
    const wantDefault = req.body?.isDefault === true;
    if (wantDefault && !row.is_default) {
      await pool.query('UPDATE ai_providers SET is_default = FALSE WHERE user_uid = $1', [uid]);
    }

    const { rows: updated } = await pool.query(
      `UPDATE ai_providers SET
         label = $2, base_url = $3, api_key_enc = $4, key_mask = $5, validated_at = $6,
         default_model = $7, enabled_models = $8::jsonb, is_default = $9, updated = $10
       WHERE id = $1 RETURNING *`,
      [row.id, label, baseUrl, apiKeyEnc, keyMask, validatedAt, defaultModel,
        JSON.stringify(enabledModels), wantDefault ? true : row.is_default, Date.now()],
    );
    res.json(rowToProvider(updated[0]));
  });

  api.delete('/ai/providers/:id', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const { rows } = await pool.query(
      'SELECT * FROM ai_providers WHERE id = $1 AND user_uid = $2',
      [Number(req.params.id), uid],
    );
    if (rows.length === 0) {
      res.status(404).json({ message: 'Provider not found' });
      return;
    }
    await pool.query('DELETE FROM ai_providers WHERE id = $1', [rows[0].id]);
    // Promote another provider if the default was deleted.
    if (rows[0].is_default) {
      await pool.query(
        `UPDATE ai_providers SET is_default = TRUE
         WHERE id = (SELECT id FROM ai_providers WHERE user_uid = $1 ORDER BY created LIMIT 1)`,
        [uid],
      );
    }
    res.json({ ok: true });
  });

  // GET /ai/providers/:id/models?refresh=1 — cached or live model list.
  api.get('/ai/providers/:id/models', auth, async (req, res) => {
    const { rows } = await pool.query(
      'SELECT * FROM ai_providers WHERE id = $1 AND user_uid = $2',
      [Number(req.params.id), req.auth.user.uid],
    );
    const row = rows[0];
    if (!row) {
      res.status(404).json({ message: 'Provider not found' });
      return;
    }
    const fresh = row.model_cache_at && Date.now() - Number(row.model_cache_at) < MODEL_CACHE_TTL;
    if (!req.query.refresh && fresh && Array.isArray(row.model_cache) && row.model_cache.length > 0) {
      res.json({ models: row.model_cache, cached: true });
      return;
    }
    const key = row.api_key_enc ? decryptSecret(row.api_key_enc) : null;
    try {
      const models = await fetchAndCacheModels(pool, row, key);
      res.json({ models, cached: false });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(400).json({ message: err.message });
        return;
      }
      if (Array.isArray(row.model_cache) && row.model_cache.length > 0) {
        res.json({ models: row.model_cache, cached: true, stale: true });
        return;
      }
      res.status(502).json({ message: `Could not reach the provider: ${err.message}` });
    }
  });

  // --- derived profile (compat: pickers read this) ------------------------------

  // GET /ai/profile — the active provider, flattened into the old shape the
  // UI already consumes (models = the enabled subset).
  api.get('/ai/profile', auth, async (req, res) => {
    await migrateLegacy(pool, req.auth.user.uid);
    const rows = await listRows(pool, req.auth.user.uid);
    if (rows.length === 0) {
      res.json({
        provider: '', providerLabel: '', baseUrl: '',
        keyConfigured: false, keyMask: null, validatedAt: null,
        model: '', reasoningLevel: 'none', interleavedReasoning: false,
        models: [], providers: [], updatedAt: 0,
      });
      return;
    }
    const active = rows.find(r => r.is_default) ?? rows[0];
    const p = rowToProvider(active);
    res.json({
      ...p,
      model: p.defaultModel,
      models: p.enabledModels.length > 0 ? p.enabledModels : p.models,
      providers: rows.map(rowToProvider),
    });
  });

  // Legacy single-profile PUT still works: it routes to the active provider
  // (or creates the first one). Kept so older clients don't break.
  api.put('/ai/profile', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    await migrateLegacy(pool, uid);
    const rows = await listRows(pool, uid);
    if (rows.length === 0) {
      // No provider yet — create the first one from the payload (validated
      // up front, same as POST /ai/providers).
      const label = String(req.body?.label || PROVIDERS[String(req.body?.provider)]?.label || 'Provider');
      const provider = String(req.body?.provider || 'deepseek');
      const baseUrl = String(req.body?.baseUrl || '').trim() || null;
      const apiKey = String(req.body?.apiKey || '').trim();
      let modelCache;
      try {
        modelCache = await listModels(provider, apiKey || null, baseUrl);
      } catch (err) {
        res.status(err instanceof AuthError ? 400 : 502).json({
          message: err instanceof AuthError ? `Validation failed: ${err.message}` : `Could not reach the provider: ${err.message}`,
        });
        return;
      }
      const now = Date.now();
      const { rows: created } = await pool.query(
        `INSERT INTO ai_providers
           (user_uid, label, provider, base_url, api_key_enc, key_mask, validated_at,
            default_model, model_cache, model_cache_at, enabled_models, is_default, created, updated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,TRUE,$12,$12) RETURNING *`,
        [uid, label, provider, baseUrl, apiKey ? encryptSecret(apiKey) : null,
          apiKey ? maskSecret(apiKey) : null, now,
          String(req.body?.model || modelCache[0] || ''),
          JSON.stringify(modelCache), now,
          JSON.stringify(Array.isArray(req.body?.models) && req.body.models.length > 0 ? req.body.models : modelCache.slice(0, 5)),
          now],
      );
      const p = rowToProvider(created[0]);
      res.json({ ...p, model: p.defaultModel, models: p.enabledModels.length > 0 ? p.enabledModels : p.models, validated: p.validatedAt != null });
      return;
    }
    const target = rows.find(r => r.is_default) ?? rows[0];
    const { rows: updated } = await pool.query(
      `UPDATE ai_providers SET
         default_model = $2, updated = $3,
         enabled_models = COALESCE($4::jsonb, enabled_models)
       WHERE id = $1 RETURNING *`,
      [target.id,
        String(req.body?.model ?? target.default_model),
        Date.now(),
        Array.isArray(req.body?.models) && req.body.models.length > 0 ? JSON.stringify(req.body.models) : null],
    );
    const p = rowToProvider(updated[0]);
    res.json({
      ...p,
      model: p.defaultModel,
      models: p.enabledModels.length > 0 ? p.enabledModels : p.models,
      validated: p.validatedAt != null,
    });
  });

  // --- chat (unchanged shape; resolves provider by model) ------------------------

  api.post('/ai/chat', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    await migrateLegacy(pool, uid);
    const model = String(req.body?.model || '');
    const row = await resolveForChat(pool, uid, model);
    if (!row) {
      res.status(400).json({ message: 'No AI provider configured. Add one in Plugins.' });
      return;
    }
    const key = row.api_key_enc ? decryptSecret(row.api_key_enc) : null;
    const def = PROVIDERS[row.provider];
    if (!key && def?.local !== true) {
      res.status(400).json({ message: 'No API key configured for the assistant provider.' });
      return;
    }
    const messages = Array.isArray(req.body?.messages)
      ? req.body.messages
          .filter(
            m =>
              m &&
              typeof m.content === 'string' &&
              (['user', 'assistant', 'system'].includes(m.role) ||
                // Tool results from the agent loop.
                (m.role === 'tool' && typeof m.tool_call_id === 'string')) &&
              // Bound tool payloads like everything else.
              m.content.length <= 64_000,
          )
          .slice(-60)
      : [];
    if (messages.length === 0) {
      res.status(400).json({ message: 'messages required' });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = async evt => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };

    const wantsTools = req.body?.tools === true;
    try {
      await streamChat(
        {
          provider: row.provider,
          apiKey: key,
          baseUrl: row.base_url,
          model: model || row.default_model,
          messages,
          reasoningLevel: String(req.body?.reasoningLevel || 'none'),
          tools: wantsTools ? TOOL_SCHEMAS : null,
        },
        send,
      );
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err.message });
    } finally {
      res.end();
    }
  });

  // --- agent tool execution ---------------------------------------------------

  // POST /ai/tools {repoPath, tool, args} — runs one assistant tool against
  // the repo on disk. Read-only tools are available to everyone; run_command
  // is gated by the caller's per-repo access profile (sync prefs).
  api.post('/ai/tools', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const repoPath = String(req.body?.repoPath || '');
    const tool = String(req.body?.tool || '');
    const args = req.body?.args && typeof req.body.args === 'object' ? req.body.args : {};

    const slash = repoPath.indexOf('/');
    if (slash <= 0 || slash === repoPath.length - 1) {
      res.status(400).json({ message: 'repoPath must be space/repo' });
      return;
    }
    const space = repoPath.slice(0, slash);
    const repo = repoPath.slice(slash + 1);

    let permissions = {};
    try {
      const { rows } = await pool.query(
        "SELECT value FROM prefs WHERE user_id = $1 AND key = 'assistant_profiles' LIMIT 1",
        [uid],
      );
      const profiles = rows[0]?.value?.repoProfiles;
      if (profiles && typeof profiles === 'object') permissions = profiles[repoPath] ?? {};
    } catch {
      // prefs unavailable → read-only defaults
    }

    try {
      const result = await executeTool(tool, space, repo, args, permissions);
      res.json(result);
    } catch (err) {
      res.status(400).json({ message: err.message });
    }
  });

  return api;
}

// AI routes — provider profile management with real validation, live model
// lists, and a streaming chat proxy. Keys never leave the server.

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

const MODEL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function rowToProfile(row) {
  const def = PROVIDERS[row.provider] ?? PROVIDERS.custom;
  return {
    provider: row.provider,
    providerLabel: def.label,
    baseUrl: row.base_url || def.defaultBase || '',
    keyConfigured: Boolean(row.api_key_enc) || def.local === true,
    keyMask: row.key_mask || null,
    validatedAt: row.validated_at == null ? null : Number(row.validated_at),
    model: row.model,
    reasoningLevel: row.reasoning_level,
    interleavedReasoning: Boolean(row.interleaved),
    models: Array.isArray(row.model_cache) ? row.model_cache : [],
    updatedAt: Number(row.updated_at),
  };
}

async function getRow(pool, uid) {
  const { rows } = await pool.query(
    'SELECT * FROM ai_provider_profiles WHERE user_uid = $1',
    [uid],
  );
  return rows[0] ?? null;
}

export function aiRoutes(pool, authenticate) {
  const api = express.Router();
  const auth = authenticate(true);

  // GET /ai/profile — current profile (no secrets).
  api.get('/ai/profile', auth, async (req, res) => {
    const row = await getRow(pool, req.auth.user.uid);
    if (!row) {
      // Sensible defaults straight from the registry.
      const def = PROVIDERS.deepseek;
      res.json({
        provider: 'deepseek',
        providerLabel: def.label,
        baseUrl: def.defaultBase,
        keyConfigured: false,
        keyMask: null,
        validatedAt: null,
        model: def.defaultModel,
        reasoningLevel: 'none',
        interleavedReasoning: false,
        models: [],
        updatedAt: 0,
      });
      return;
    }
    res.json(rowToProfile(row));
  });

  // PUT /ai/profile — save provider settings. When an apiKey is supplied it
  // is validated against the live provider before being stored (encrypted).
  api.put('/ai/profile', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const existing = await getRow(pool, uid);

    const provider = String(req.body?.provider || existing?.provider || 'deepseek');
    const def = PROVIDERS[provider];
    if (!def) {
      res.status(400).json({ message: `Unknown provider '${provider}'. Supported: ${Object.keys(PROVIDERS).join(', ')}` });
      return;
    }
    const baseUrl = String(req.body?.baseUrl || existing?.base_url || '').trim() || null;
    if (def.needsBaseUrl && !baseUrl) {
      res.status(400).json({ message: 'A base URL is required for custom providers' });
      return;
    }
    const model = String(req.body?.model || existing?.model || def.defaultModel || '');
    const reasoningLevel = ['none', 'low', 'medium', 'high'].includes(req.body?.reasoningLevel)
      ? String(req.body?.reasoningLevel)
      : (existing?.reasoning_level ?? 'none');
    const interleaved = req.body?.interleavedReasoning !== undefined
      ? Boolean(req.body.interleavedReasoning)
      : Boolean(existing?.interleaved ?? false);

    const apiKey = typeof req.body?.apiKey === 'string' && req.body.apiKey.length > 0
      ? req.body.apiKey.trim()
      : null;

    let apiKeyEnc = existing?.api_key_enc ?? null;
    let keyMask = existing?.key_mask ?? null;
    let validatedAt = existing?.validated_at ?? null;
    let modelCache = existing?.model_cache ?? [];
    let modelCacheAt = existing?.model_cache_at ?? null;

    // Validate + (re)fetch models whenever a key is supplied or the
    // endpoint/provider changed.
    const effectiveKey = apiKey ?? (apiKeyEnc ? decryptSecret(apiKeyEnc) : null);
    const endpointChanged =
      (existing?.provider ?? null) !== provider || (existing?.base_url ?? null) !== baseUrl;

    if (apiKey || (endpointChanged && effectiveKey) || (validatedAt == null && effectiveKey)) {
      try {
        const models = await listModels(provider, effectiveKey, baseUrl);
        modelCache = models;
        modelCacheAt = Date.now();
        validatedAt = Date.now();
        if (apiKey) {
          apiKeyEnc = encryptSecret(apiKey);
          keyMask = maskSecret(apiKey);
        }
      } catch (err) {
        if (err instanceof AuthError) {
          res.status(400).json({ message: `Validation failed: ${err.message}` });
          return;
        }
        res.status(502).json({ message: `Could not reach the provider: ${err.message}` });
        return;
      }
    }

    const now = Date.now();
    await pool.query(
      `INSERT INTO ai_provider_profiles
         (user_uid, provider, base_url, api_key_enc, key_mask, validated_at, model, reasoning_level, interleaved, model_cache, model_cache_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
       ON CONFLICT (user_uid) DO UPDATE SET
         provider = EXCLUDED.provider, base_url = EXCLUDED.base_url,
         api_key_enc = EXCLUDED.api_key_enc, key_mask = EXCLUDED.key_mask,
         validated_at = EXCLUDED.validated_at, model = EXCLUDED.model,
         reasoning_level = EXCLUDED.reasoning_level, interleaved = EXCLUDED.interleaved,
         model_cache = EXCLUDED.model_cache, model_cache_at = EXCLUDED.model_cache_at,
         updated_at = EXCLUDED.updated_at`,
      [uid, provider, baseUrl, apiKeyEnc, keyMask, validatedAt, model, reasoningLevel, interleaved,
        JSON.stringify(modelCache), modelCacheAt, now],
    );
    const row = await getRow(pool, uid);
    res.json({ ...rowToProfile(row), validated: validatedAt != null });
  });

  // GET /ai/models — live model list (cached 10 minutes).
  api.get('/ai/models', auth, async (req, res) => {
    const uid = req.auth.user.uid;
    const row = await getRow(pool, uid);
    if (!row) {
      res.status(400).json({ message: 'No provider configured yet' });
      return;
    }
    const fresh = row.model_cache_at && Date.now() - Number(row.model_cache_at) < MODEL_CACHE_TTL;
    if (fresh && Array.isArray(row.model_cache) && row.model_cache.length > 0) {
      res.json({ models: row.model_cache, cached: true });
      return;
    }
    const key = row.api_key_enc ? decryptSecret(row.api_key_enc) : null;
    try {
      const models = await listModels(row.provider, key, row.base_url);
      await pool.query(
        'UPDATE ai_provider_profiles SET model_cache = $2::jsonb, model_cache_at = $3 WHERE user_uid = $1',
        [uid, JSON.stringify(models), Date.now()],
      );
      res.json({ models, cached: false });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(400).json({ message: err.message });
        return;
      }
      // Fall back to the stale cache when the provider is unreachable.
      if (Array.isArray(row.model_cache) && row.model_cache.length > 0) {
        res.json({ models: row.model_cache, cached: true, stale: true });
        return;
      }
      res.status(502).json({ message: `Could not reach the provider: ${err.message}` });
    }
  });

  // POST /ai/chat — streaming chat proxy (unified SSE).
  // Body: { messages: [{role, content}], model?, reasoningLevel? }
  api.post('/ai/chat', auth, async (req, res) => {
    const row = await getRow(pool, req.auth.user.uid);
    if (!row) {
      res.status(400).json({ message: 'No AI provider configured. Set one up in Plugins.' });
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
          .filter(m => m && (m.role === 'user' || m.role === 'assistant' || m.role === 'system') && typeof m.content === 'string')
          .slice(-40)
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

    try {
      await streamChat({
        provider: row.provider,
        apiKey: key,
        baseUrl: row.base_url,
        model: String(req.body?.model || row.model),
        messages,
        reasoningLevel: String(req.body?.reasoningLevel || row.reasoning_level),
      }, send);
      await send({ type: 'done' });
    } catch (err) {
      await send({ type: 'error', message: err instanceof AuthError ? err.message : err.message });
    } finally {
      res.end();
    }
  });

  return api;
}

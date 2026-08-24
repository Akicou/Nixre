// OpenAI-compatible speech-to-text proxy. The browser never sees the key;
// core forwards audio to the user's configured transcriptions endpoint.

import { pool } from '../db/pool.js';
import { decryptSecret } from './ai.js';

const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export function sttApiRoot(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(b) ? b : `${b}/v1`;
}

export async function getSttRow(uid) {
  if (!uid) return null;
  const { rows } = await pool.query('SELECT * FROM user_stt WHERE user_uid = $1', [uid]);
  return rows[0] || null;
}

export function rowToStt(row) {
  if (!row) {
    return { configured: false, base_url: null, model: null, key_mask: null };
  }
  return {
    configured: true,
    base_url: row.base_url,
    model: row.model,
    key_mask: row.key_mask || null,
  };
}

function mimeFor(format) {
  const f = String(format || 'webm').toLowerCase();
  if (f === 'wav') return 'audio/wav';
  if (f === 'mp3') return 'audio/mpeg';
  if (f === 'ogg') return 'audio/ogg';
  if (f === 'mp4' || f === 'm4a') return 'audio/mp4';
  if (f === 'flac') return 'audio/flac';
  return 'audio/webm';
}

export async function transcribeAudio(uid, { audioB64, format }) {
  const row = await getSttRow(uid);
  if (!row) {
    const err = new Error('Speech-to-text is not configured. Add an endpoint in Settings → Speech.');
    err.status = 400;
    throw err;
  }
  const raw = String(audioB64 || '').replace(/^data:[^;]+;base64,/, '');
  let buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch {
    const err = new Error('Invalid audio payload');
    err.status = 400;
    throw err;
  }
  if (!buf.length) {
    const err = new Error('Empty audio');
    err.status = 400;
    throw err;
  }
  if (buf.length > MAX_AUDIO_BYTES) {
    const err = new Error('Audio is too large (8 MB max)');
    err.status = 400;
    throw err;
  }
  const ext = String(format || 'webm').replace(/[^a-z0-9]/gi, '') || 'webm';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)], { type: mimeFor(ext) }), `clip.${ext}`);
  form.append('model', row.model || 'whisper-1');
  const headers = {};
  const key = row.api_key_enc ? decryptSecret(row.api_key_enc) : null;
  if (key) headers.Authorization = `Bearer ${key}`;
  const url = `${sttApiRoot(row.base_url)}/audio/transcriptions`;
  const res = await fetch(url, { method: 'POST', headers, body: form });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = json?.error?.message || json?.message || text.slice(0, 240) || `Transcription failed (${res.status})`;
    const err = new Error(msg);
    err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
    throw err;
  }
  const transcript = json && typeof json === 'object'
    ? (json.text || json.transcription || '')
    : text;
  return { text: String(transcript || '').trim() };
}

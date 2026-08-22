// Web search — a self-contained search backend for the assistant's
// `web_search` tool. Ported from the Nayhein SearchEngine (Python/FastAPI)
// into Node so nixre-core owns the whole path (no sidecar service).
//
// Strategy: try the Qwant public web API first; when its anti-bot layer
// blocks (403/404), fall back to DuckDuckGo's HTML endpoint, then to the
// Jina reader mirror of DuckDuckGo. Every result is normalized to
// { title, url, content, source }.

const QWANT_WEB_API_URL = 'https://api.qwant.com/v3/search/web';
const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';
const JINA_READER_PREFIX = 'https://r.jina.ai/';
const JINA_DUCKDUCKGO_READER_URL = `${JINA_READER_PREFIX}https://html.duckduckgo.com/html/`;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const DEFAULT_MAX_RESULTS = 8;
const MAX_RESULTS = 20;

async function fetchText(url, { headers = {}, timeout = 30_000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'follow',
      signal: controller.signal,
    });
    return { status: r.status, ok: r.ok, text: await r.text() };
  } finally {
    clearTimeout(timer);
  }
}

// --- Qwant -------------------------------------------------------------------

async function qwantWebSearch(query) {
  const params = new URLSearchParams({
    q: query,
    count: '10',
    locale: 'en_US',
    offset: '0',
    device: 'desktop',
    safesearch: '1',
    displayed: 'true',
    llm: 'false',
  });
  const { status, ok, text } = await fetchText(`${QWANT_WEB_API_URL}?${params}`, {
    headers: {
      Accept: 'application/json',
      Referer: `https://www.qwant.com/?q=${encodeURIComponent(query)}&t=web`,
    },
  });
  if (status === 403 || status === 404) return [];
  if (!ok) throw new Error(`Qwant returned HTTP ${status}`);
  return extractQwantResults(JSON.parse(text));
}

function extractQwantResults(data) {
  const legacy = data?.data?.results;
  if (Array.isArray(legacy)) {
    return legacy.filter(r => r && typeof r === 'object');
  }
  const items = data?.data?.result?.items;
  const blocks = [];
  if (items && typeof items === 'object') {
    blocks.push(...(items.mainline || []));
    blocks.push(...(items.sidebar || []));
  }
  const results = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    for (const item of block.items || []) {
      if (!item || typeof item !== 'object') continue;
      const title = item.title || item.name;
      const url = item.url || item.href;
      if (title && url) {
        results.push({
          title: String(title),
          url: String(url),
          content: String(item.desc || item.description || ''),
          source: 'qwant',
        });
      }
    }
  }
  return results.slice(0, 10);
}

// --- DuckDuckGo (HTML scrape) -------------------------------------------------

async function duckduckgoHtmlSearch(query) {
  const params = new URLSearchParams({ q: query });
  const { ok, status, text } = await fetchText(`${DUCKDUCKGO_HTML_URL}?${params}`);
  if (!ok) throw new Error(`DuckDuckGo returned HTTP ${status}`);

  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const title = stripHtml(m[2]);
    const url = normalizeDuckDuckGoUrl(decodeHtml(m[1]));
    if (title && url && !isDuckDuckGoAdUrl(url)) {
      results.push({ title, url, content: '', source: 'duckduckgo' });
    }
    if (results.length >= 10) break;
  }
  return results;
}

// --- DuckDuckGo via Jina reader (markdown) ------------------------------------

async function jinaDuckDuckGoSearch(query) {
  const params = new URLSearchParams({ q: query });
  const { ok, status, text } = await fetchText(`${JINA_DUCKDUCKGO_READER_URL}?${params}`, {
    headers: { Accept: 'text/plain, application/json' },
    timeout: 45_000,
  });
  if (!ok) throw new Error(`Jina reader returned HTTP ${status}`);

  const results = [];
  for (const line of text.split('\n')) {
    const stripped = line.trim();
    if (!stripped.startsWith('#') || !stripped.includes('](')) continue;
    const titleStart = stripped.indexOf('[');
    const titleEnd = stripped.indexOf('](', titleStart);
    const urlEnd = stripped.lastIndexOf(')');
    if (titleStart === -1 || titleEnd === -1 || urlEnd === -1) continue;
    const title = stripped.slice(titleStart + 1, titleEnd).trim();
    const url = normalizeDuckDuckGoUrl(stripped.slice(titleEnd + 2, urlEnd).trim());
    if (title && url && !url.includes('duckduckgo.com/html') && !isDuckDuckGoAdUrl(url)) {
      results.push({ title, url, content: '', source: 'duckduckgo-jina' });
    }
    if (results.length >= 10) break;
  }
  return results;
}

// --- helpers ------------------------------------------------------------------

function stripHtml(value) {
  return decodeHtml(String(value).replace(/<[^>]+>/g, '')).trim();
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function normalizeDuckDuckGoUrl(url) {
  if (url.startsWith('//')) url = `https:${url}`;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const uddg = parsed.searchParams.get('uddg');
  if (uddg) return decodeURIComponent(uddg);
  return url;
}

function isDuckDuckGoAdUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.hostname.endsWith('duckduckgo.com') && parsed.pathname.endsWith('/y.js');
  } catch {
    return false;
  }
}

// --- public API ---------------------------------------------------------------

/**
 * Search the web for `query`. Returns normalized results (best-effort: an
 * empty list when every backend is blocked, never a thrown error).
 */
export async function webSearch(query, { maxResults = DEFAULT_MAX_RESULTS } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query is required');
  const limit = Math.max(1, Math.min(MAX_RESULTS, Number(maxResults) || DEFAULT_MAX_RESULTS));

  let results = [];
  try {
    results = await qwantWebSearch(q);
  } catch {
    results = [];
  }
  if (results.length === 0) {
    try {
      results = await jinaDuckDuckGoSearch(q);
    } catch {
      results = [];
    }
  }
  if (results.length === 0) {
    try {
      results = await duckduckgoHtmlSearch(q);
    } catch {
      results = [];
    }
  }

  return {
    query: q,
    results: results.slice(0, limit).map(r => ({
      title: String(r.title || ''),
      url: String(r.url || ''),
      content: String(r.content || ''),
      source: String(r.source || 'nixre'),
    })),
  };
}

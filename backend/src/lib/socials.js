// Social links, shared by user profiles (users.socials) and organizations
// (spaces.socials). Both store a JSONB array of { platform, url }.
//
// These URLs are rendered as `<a href>` in the UI, so the protocol check is a
// security boundary, not tidiness: it is what keeps `javascript:` out.

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const MAX_LINKS = 25;
const MAX_PLATFORM = 40;
const MAX_URL = 500;

// One link, or null if it cannot be made into a usable one.
export function normalizeSocial(entry) {
  const raw = String(entry?.url || '').trim();
  if (!raw) return null;
  // People paste `github.com/name`, not `https://github.com/name`. Assume
  // https rather than dropping the link and leaving them wondering why the
  // row vanished.
  const candidate = HAS_SCHEME.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.')) return null;

  const url = parsed.href.slice(0, MAX_URL);
  // An empty platform is a label the user did not bother to type, not a
  // reason to discard the link: name it after the host.
  const platform = (String(entry?.platform || '').trim()
    || parsed.hostname.replace(/^www\./, '').split('.')[0]).slice(0, MAX_PLATFORM);
  return platform ? { platform, url } : null;
}

// A whole list. `fallback` is returned when the caller sent no array at all,
// so a PATCH that omits socials leaves the stored ones alone — sending `[]`
// still clears them.
export function sanitizeSocials(input, fallback = []) {
  const list = Array.isArray(input) ? input : fallback;
  return list.map(normalizeSocial).filter(Boolean).slice(0, MAX_LINKS);
}

// Baseline HTTP response headers.
//
// nixre-core serves a single-page app, a JSON API, and a git HTTP transport
// from one origin, so a small static policy covers everything: no framed
// embedding, no MIME sniffing (important — we serve user-uploaded avatars and
// raw repository blobs), and no referrer leakage to third-party sites the UI
// links out to.

export function securityHeaders(_req, res, next) {
  // Clickjacking: nothing in Nixre is designed to be framed.
  res.set('X-Frame-Options', 'DENY');
  // Legacy counterpart to frame-ancestors.
  res.set('Content-Security-Policy', "frame-ancestors 'none'");
  // Avatars and raw blobs are user-controlled bytes; never let the browser
  // reinterpret them as an active type.
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  // Permissions the app never asks for — deny them outright.
  res.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  // The API is not cached by shared proxies; individual handlers (avatar
  // no-cache, static SPA assets) override this where it matters.
  res.set('Cache-Control', 'no-store');
  next();
}

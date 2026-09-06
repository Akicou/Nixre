// In-memory fixed-window rate limiter.
//
// nixre-core is a self-hosted single-process service, so a process-local map is
// the right tool: no extra dependency, no shared-state coordination, and the
// limits reset on restart (acceptable — they exist to stop online brute force,
// not to meter billing).
//
// Usage:
//   const limiter = createRateLimiter({ windowMs: 60_000, max: 10 });
//   app.post('/login', limiter(keyFn), handler);
//
// The key function usually combines a route name with the caller identity (see
// clientKey below). Buckets are swept lazily so idle traffic costs nothing.

/**
 * @param {object} options
 * @param {number} options.windowMs  length of the counting window
 * @param {number} options.max       requests allowed per window per key
 * @param {string} [options.name]    label used in the error message
 */
export function createRateLimiter({ windowMs, max, name = 'requests' }) {
  const buckets = new Map();
  let lastSweep = 0;

  return function limit(keyFn) {
    return (req, res, next) => {
      const now = Date.now();
      if (now - lastSweep > windowMs) {
        for (const [key, bucket] of buckets) {
          if (bucket.resetAt <= now) buckets.delete(key);
        }
        lastSweep = now;
      }
      const rawKey = typeof keyFn === 'function' ? keyFn(req) : String(keyFn);
      const key = `${rawKey}:${Math.floor(now / windowMs)}`;
      const bucket = buckets.get(key) || { count: 0, resetAt: (Math.floor(now / windowMs) + 1) * windowMs };
      bucket.count += 1;
      buckets.set(key, bucket);

      const remaining = Math.max(0, max - bucket.count);
      const resetSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('X-RateLimit-Limit', String(max));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetSeconds));

      if (bucket.count > max) {
        res.set('Retry-After', String(resetSeconds));
        res.status(429).json({
          message: `Too many ${name}. Try again in ${resetSeconds}s.`,
        });
        return;
      }
      next();
    };
  };
}

/**
 * Express resolves req.ip using the explicit trusted proxy IP/CIDR list.
 * Never parse forwarded headers independently of that trust boundary.
 */
export function clientKey(req) {
  return req?.ip || req?.socket?.remoteAddress || 'unknown';
}

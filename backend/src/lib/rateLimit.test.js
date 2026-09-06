// Rate limiter — fixed-window counting, header emission, and the fact that a
// caller who exceeds the limit is actually stopped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter, clientKey } from './rateLimit.js';

function fakeRes() {
  const headers = {};
  return {
    headers,
    statusCode: null,
    body: null,
    set(name, value) {
      headers[name.toLowerCase()] = String(value);
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('allows up to the limit, then blocks with 429', () => {
  const limit = createRateLimiter({ windowMs: 60_000, max: 3, name: 'logins' });
  const mw = limit(() => 'k');

  let nextCalls = 0;
  const next = () => {
    nextCalls += 1;
  };

  for (let i = 0; i < 3; i++) {
    const res = fakeRes();
    mw({}, res, next);
    assert.equal(res.statusCode, null, `request ${i + 1} should pass`);
  }
  assert.equal(nextCalls, 3);

  const res = fakeRes();
  mw({}, res, next);
  assert.equal(res.statusCode, 429);
  assert.equal(nextCalls, 3, 'the blocked request must not reach the handler');
  assert.match(res.body.message, /Too many logins/);
  // Retry-After is the remainder of the current window, so it depends on the
  // wall clock — assert it is a sane positive value bounded by the window.
  const retryAfter = Number(res.headers['retry-after']);
  assert.ok(retryAfter > 0 && retryAfter <= 60, `Retry-After was ${retryAfter}`);
});

test('counts are per key', () => {
  const limit = createRateLimiter({ windowMs: 60_000, max: 1 });
  const mw = limit(req => req.key);

  const a1 = fakeRes();
  mw({ key: 'a' }, a1, () => {});
  const a2 = fakeRes();
  mw({ key: 'a' }, a2, () => {});
  assert.equal(a2.statusCode, 429);

  const b1 = fakeRes();
  mw({ key: 'b' }, b1, () => {});
  assert.equal(b1.statusCode, null, 'a different key has its own budget');
});

test('emits rate-limit headers on allowed requests', () => {
  const limit = createRateLimiter({ windowMs: 60_000, max: 5 });
  const mw = limit(() => 'k');
  const res = fakeRes();
  mw({}, res, () => {});
  assert.equal(res.headers['x-ratelimit-limit'], '5');
  assert.equal(res.headers['x-ratelimit-remaining'], '4');
});

test('clientKey uses Express identity, never raw forwarded headers', () => {
  const req = {
    socket: { remoteAddress: '203.0.113.9' },
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
  };

  assert.equal(clientKey(req), '203.0.113.9', 'untrusted: use the socket address');
  req.ip = '5.6.7.8';
  assert.equal(clientKey(req), '5.6.7.8');
});

test('limiter instances have independent counters; one instance can share a budget', () => {
  const login = createRateLimiter({ windowMs: 60_000, max: 1 });
  const tools = createRateLimiter({ windowMs: 60_000, max: 1 });
  login(() => 'caller')({}, fakeRes(), () => {});
  const independent = fakeRes();
  tools(() => 'caller')({}, independent, () => {});
  assert.equal(independent.statusCode, null);
  const shared = fakeRes();
  login(() => 'caller')({}, shared, () => {});
  assert.equal(shared.statusCode, 429);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSocials, normalizeSocial } from '../lib/socials.js';

test('a pasted handle without a scheme is kept, not dropped', () => {
  assert.deepEqual(normalizeSocial({ platform: 'github', url: 'github.com/Akicuo' }), {
    platform: 'github',
    url: 'https://github.com/Akicuo',
  });
});

test('a missing platform is named after the host', () => {
  assert.deepEqual(normalizeSocial({ platform: '  ', url: 'https://www.linkedin.com/in/x' }), {
    platform: 'linkedin',
    url: 'https://www.linkedin.com/in/x',
  });
});

test('non-http(s) URLs are refused — these render as href', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'mailto:a@b.com', 'file:///etc/passwd']) {
    assert.equal(normalizeSocial({ platform: 'x', url }), null, url);
  }
});

test('unusable entries are refused', () => {
  assert.equal(normalizeSocial({ platform: 'github', url: '   ' }), null);
  assert.equal(normalizeSocial({ platform: 'localhost', url: 'localhost' }), null);
  assert.equal(normalizeSocial(null), null);
});

test('a non-array falls back, an empty array clears', () => {
  const stored = [{ platform: 'github', url: 'https://github.com/a' }];
  assert.deepEqual(sanitizeSocials(undefined, stored), stored);
  assert.deepEqual(sanitizeSocials([], stored), []);
});

test('the list is capped and bad rows do not take good ones down with them', () => {
  const input = [
    { platform: 'github', url: 'github.com/a' },
    { platform: 'evil', url: 'javascript:alert(1)' },
    { platform: 'site', url: 'https://example.com' },
  ];
  assert.deepEqual(sanitizeSocials(input).map(s => s.platform), ['github', 'site']);
  assert.equal(sanitizeSocials(Array(50).fill({ platform: 'x', url: 'https://example.com' })).length, 25);
});

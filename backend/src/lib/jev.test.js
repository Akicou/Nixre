import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jevJudge, isOpenRouter } from './jev.js';

const reply = (body, ok = true, status = 200) => async () => ({ ok, status, json: async () => body });
const run = fetchImpl => jevJudge('run_command', { command: 'x' }, { apiKey: 'k', baseUrl: 'https://openrouter.ai/api/v1', fetchImpl });

test('jev verdicts: allow below threshold, deny above, fail closed otherwise', async () => {
  assert.equal(await run(reply({ answers: { unsafe: { type: 'noul', noul: 0.05 } } })), 'ALLOW');
  assert.match(await run(reply({ answers: { unsafe: { noul: 0.76 } } })), /^DENY: .*76%/);
  assert.match(await run(reply({ answers: {} })), /^DENY/);
  assert.match(await run(reply({}, false, 401)), /^DENY.*401/);
});

test('jev request goes to the OpenRouter decisions endpoint with the command', async () => {
  let seen;
  await run(async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ answers: { unsafe: { noul: 0 } } }) }; });
  assert.equal(seen.url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(seen.init.headers.Authorization, 'Bearer k');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.model, 'typesafe/jev-1.14');
  assert.equal(body.state.args.command, 'x');
});

test('isOpenRouter only matches openrouter hosts', () => {
  assert.ok(isOpenRouter('https://openrouter.ai/api/v1'));
  assert.ok(!isOpenRouter('http://localhost:11434/v1'));
});

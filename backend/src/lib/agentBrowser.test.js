import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source = await fs.readFile(new URL('./agentBrowser.cjs', import.meta.url), 'utf8');
async function run(url) {
  let launched = false, result, requestRoute;
  const process = { argv: ['node', JSON.stringify({ url })], exitCode: 0 };
  const context = vm.createContext({
    URL, Buffer, process,
    require: name => name.includes('playwright') ? { chromium: { launch: async () => {
      launched = true;
      return { close: async () => {}, newContext: async () => ({ route: async (_pattern, handler) => { requestRoute = handler; }, newPage: async () => ({
        on: () => {}, goto: async () => ({ status: () => 200 }), title: async () => 'Preview', screenshot: async () => {},
      }) }) };
    } } } : { mkdir: async () => {}, readFile: async () => Buffer.from('png') },
    console: { log: text => { result = JSON.parse(text); } },
  });
  await vm.runInContext(source, context);
  return { launched, result, process, requestRoute };
}
test('browser checks reject non-local URLs before launching a browser', async () => {
  for (const url of ['https://example.com', 'file:///etc/passwd', 'http://localhost@evil.example', 'http://169.254.169.254']) {
    const out = await run(url);
    assert.equal(out.launched, false);
    assert.match(out.result.error, /local HTTP/);
  }
});
test('browser checks return screenshot data and block cross-origin HTTP resources', async () => {
  const out = await run('http://localhost:3000');
  assert.equal(out.result.title, 'Preview');
  assert.match(out.result.dataUrl, /^data:image\/png;base64,/);
  let blocked = false;
  out.requestRoute({ request: () => ({ url: () => 'https://external.example/script.js' }), abort: () => { blocked = true; }, continue: () => assert.fail() });
  assert.equal(blocked, true);
});

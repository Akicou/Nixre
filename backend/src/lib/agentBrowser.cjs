// Invoked as a one-shot process in the agent sandbox, never on the core host.
const { chromium } = require('/usr/local/lib/node_modules/playwright');
const fs = require('node:fs/promises');
(async () => {
  const args = JSON.parse(process.argv[1]);
  const url = new URL(args.url);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Browser checks require a local HTTP preview URL');
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'block' });
    const errors = [], consoleMessages = [], blocked = [];
    await context.route('**/*', route => {
      const target = new URL(route.request().url());
      if (target.origin === url.origin || target.protocol === 'data:') return route.continue();
      if (blocked.length < 30) blocked.push(target.href.slice(0, 300));
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', err => { if (errors.length < 30) errors.push(err.message.slice(0, 1000)); });
    page.on('console', msg => { if (consoleMessages.length < 30) consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 1000) }); });
    const response = await page.goto(url.href, { waitUntil: 'networkidle', timeout: 30000 });
    await fs.mkdir('/workspace/repo/.nixre-artifacts', { recursive: true });
    const path = `.nixre-artifacts/browser-${Date.now()}.png`;
    await page.screenshot({ path: '/workspace/repo/' + path, fullPage: false });
    const image = await fs.readFile('/workspace/repo/' + path);
    console.log(JSON.stringify({ url: url.href, status: response?.status(), title: await page.title(), errors, console: consoleMessages, blocked, path, ...(image.length <= 2 * 1024 * 1024 ? { dataUrl: 'data:image/png;base64,' + image.toString('base64') } : {}) }));
  } finally { await browser.close(); }
})().catch(error => { console.log(JSON.stringify({ error: error.message })); process.exitCode = 1; });

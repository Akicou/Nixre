import { test as base, expect, type Page } from '@playwright/test';
import type { DeployService, StandaloneServiceInput } from '../src/lib/api';

const servicesPath = '/api/v1/spaces/lab/deployments/services';
const postgres: DeployService = {
  id: 42, name: 'postgres', space_uid: 'lab', source_type: 'image', template: 'postgres', image_ref: 'postgres:17',
  internal_hostname: 'nixre-svc-42', exposure: 'internal', deployment_strategy: 'recreate',
  volume_name: 'nixre-service-42-data', volume_path: '/var/lib/postgresql/data', can_write: true,
  root_dir: '.', dockerfile_path: 'Dockerfile', branch: 'main', auto_deploy: false, container_port: 5432,
  cpu_nano_cpus: 1e9, memory_bytes: 512 * 1048576, desired_state: 'running', status: 'running',
  current_deployment_id: 9, last_failed_deployment_id: null, preserve_status_min: 400,
  success_retention_hours: 24, failure_retention_hours: 168, created: 1, updated: 2,
};
const llama: DeployService = {
  ...postgres, id: 43, name: 'llama-server', source_type: 'git', template: null, image_ref: null,
  git_url: 'https://github.com/ggml-org/llama.cpp', branch: 'master', dockerfile_path: '.devops/cpu.Dockerfile',
  build_target: 'server', volume_path: null, volume_name: null, container_port: 8080,
  internal_hostname: 'nixre-svc-43', memory_bytes: 8192 * 1048576,
  runtime_options: {
    version: 1, health_type: 'http', health_path: '/health', health_timeout_ms: 300000,
    command: ['--model', '/models/model.gguf'], entrypoint: ['/app/llama-server'],
    host_config: { binds: ['/srv/models/model.gguf:/models/model.gguf:ro'], gpus: null, privileged: false,
      cap_add: [], cap_drop: [], devices: [], group_add: [], extra_hosts: [], shm_size: null, tmpfs: {}, network_mode: null },
  },
};

type Fixture = {
  creates: StandaloneServiceInput[];
  deployIds: number[];
  requests: string[];
  failDeploy: boolean;
  logLoads: number;
};

// Exercise the production bundle and native browser behavior, never a live backend.
const test = base.extend<{ standalone: Fixture }>({
  standalone: async ({ page }, use) => {
    const state: Fixture = { creates: [], deployIds: [], requests: [], failDeploy: false, logLoads: 0 };
    const services = [postgres, llama];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('nixre_token', 'standalone-browser-test-session');
      localStorage.setItem('nixre_sync_migrated', '1');
    });
    await page.route('**/*', route => new URL(route.request().url()).origin === 'http://127.0.0.1:4179'
      ? route.continue() : route.abort());
    await page.route('**/api/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const path = decodeURIComponent(url.pathname);
      const method = request.method();
      state.requests.push(`${method} ${path}`);
      const json = (value: unknown) => route.fulfill({ json: value });
      if (path === '/api/v1/user') return json({ uid: 'jane', display_name: 'Jane', admin: true });
      if (path === '/api/sync/v1/prefs') return json({});
      if (path.includes('/avatars/')) return route.fulfill({ status: 404 });
      if (path === '/api/v1/spaces/lab') return json({ id: 1, uid: 'lab', path: 'lab', description: 'Browser fixture space', is_public: true, is_personal: false, can_manage: true, role: 'owner', created: 1735689600000 });
      if (path.endsWith('/contributions')) return json({ year: Number(url.searchParams.get('year')), total: 0, days: [] });
      if (path === '/api/v1/spaces/lab/deployments') return json({ services, activity: [], can_write: true,
        capabilities: { host_mounts: true, bind_allowlist: ['/srv/models'], gpus: true, git_hosts: ['github.com'] } });
      if (path === servicesPath && method === 'POST') {
        const input = request.postDataJSON() as StandaloneServiceInput;
        state.creates.push(input);
        const service = { ...(input.source_type === 'git' ? llama : postgres), id: 84, name: input.name, internal_hostname: 'nixre-svc-84' };
        services.push(service);
        return json(service);
      }
      const match = path.match(/^\/api\/v1\/spaces\/lab\/deployments\/services\/(\d+)(.*)$/);
      if (match) {
        const id = Number(match[1]);
        const suffix = match[2];
        if (!suffix && method === 'GET') return json(services.find(service => service.id === id));
        if (suffix === '/events') return route.fulfill({ contentType: 'text/event-stream', body: '' });
        if (suffix === '/deploy' && method === 'POST') {
          state.deployIds.push(id);
          if (state.failDeploy) {
            state.failDeploy = false;
            return route.fulfill({ status: 503, json: { message: 'Builder unavailable' } });
          }
          return json({ deploymentId: 10 });
        }
        if (suffix === '/stats') return json({ latest: null, series: [], limits: { cpu_nano_cpus: 1e9, memory_bytes: 512 * 1048576 } });
        if (suffix === '/uptime') return json({ range: '24h', bucket_ms: 900000, buckets: [], uptime_pct: null, checks_total: 0 });
        if (suffix === '/deployments') return json([]);
        if (suffix === '/runtime-logs') return json({ logs: `Fixture service ${id}: runtime snapshot ${++state.logLoads}\nListening on the internal network.` });
      }
      if (method !== 'GET') return route.fulfill({ status: 400, json: { message: 'Unexpected fixture mutation' } });
      return json([]);
    });
    await page.goto('/lab?tab=deployments');
    await expect(page.getByTestId('space-deployments-board')).toBeVisible();
    await use(state);
    expect(errors).toEqual([]);
    expect(state.requests.filter(request => /\/api\/v1\/repos\/|\/dockerfiles|\/reveal/.test(request))).toEqual([]);
    expect(state.requests.filter(request => !request.startsWith('GET ') && ![
      `POST ${servicesPath}`, `POST ${servicesPath}/84/deploy`,
    ].includes(request))).toEqual([]);
  },
});

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const dialog = page.getByRole('dialog');
  if (await dialog.count()) {
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  }
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport });

    test('space board fits, filters services, and traps/restores keyboard focus', async ({ page, standalone }) => {
      await expect(page.getByRole('heading', { name: 'A home for everything you run.' })).toBeVisible();
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('space-board.png'), fullPage: true });
      await page.getByRole('searchbox', { name: 'Search services' }).fill('postgres');
      await expect(page.getByTestId('board-card-postgres')).toBeVisible();
      await expect(page.getByTestId('board-card-llama-server')).toHaveCount(0);
      await page.getByRole('searchbox', { name: 'Search services' }).fill('');
      const opener = page.getByRole('button', { name: 'New service', exact: true });
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'New service' });
      await expect(dialog.getByRole('heading', { name: 'New service' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close setup' })).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused();
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('wizard-source.png') });
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(opener).toBeFocused();
      expect(await page.locator('body').evaluate(element => element.style.overflow)).not.toBe('hidden');
      expect(standalone.creates).toEqual([]);
    });

    test('PostgreSQL validates native inputs and creates then deploys without a repository', async ({ page, standalone }) => {
      await page.getByRole('button', { name: 'Try PostgreSQL' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      const name = dialog.getByRole('textbox', { name: /^Service name/ });
      await name.fill('Invalid name');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(name).toBeFocused();
      expect(await name.evaluate(element => (element as HTMLInputElement).validity.patternMismatch)).toBe(true);
      await name.fill('catalog-db');
      const database = dialog.getByRole('textbox', { name: 'Database name', exact: true });
      await database.fill('bad-name');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(database).toBeFocused();
      expect(standalone.creates).toEqual([]);
      await database.fill('catalog');
      await dialog.getByRole('textbox', { name: 'Database user', exact: true }).fill('catalog_user');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByRole('heading', { name: 'One last look.' })).toBeVisible();
      await expect(dialog).toContainText('Internal TCP 5432 / stop then start / retain volume');
      await expect(dialog).toContainText('/var/lib/postgresql/data');
      await expect(dialog).toContainText('Password generated and encrypted by server. Backups not configured.');
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('postgres-review.png') });
      await dialog.getByRole('button', { name: 'Create and deploy' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/tab=deployments&service=84/);
      await expect(page.getByRole('region', { name: 'Selected service details' }).getByRole('heading', { name: 'catalog-db' })).toBeVisible();
      expect(standalone.creates).toEqual([{ name: 'catalog-db', source_type: 'image', template: 'postgres', image_ref: 'postgres:17', database: 'catalog', username: 'catalog_user', cpu_cores: 1, memory_mb: 512 }]);
      expect(standalone.deployIds).toEqual([84]);
      expect(standalone.requests.indexOf(`POST ${servicesPath}`)).toBeLessThan(standalone.requests.indexOf(`POST ${servicesPath}/84/deploy`));
      await expectNoOverflow(page);
    });

    test('typed host model reaches review with explicit safe mount, network and GPU configuration', async ({ page, standalone }) => {
      await page.getByRole('button', { name: 'Try llama.cpp' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('combobox', { name: 'Deploy from', exact: true }).selectOption('pr');
      await dialog.getByLabel(/^Pull request number/).fill('12345');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('textbox', { name: /^Service name/ }).fill('model-server');
      await expect(dialog.getByRole('combobox', { name: /^Compute/ })).toHaveValue('cpu');
      const model = dialog.getByRole('textbox', { name: /^Host GGUF file path/ });
      await model.fill('/srv/models-other/model.gguf');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByRole('alert')).toContainText('approved prefix');
      await model.fill('/srv/models/../private/model.gguf');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByRole('alert')).toContainText('approved prefix');
      await model.fill('');
      await model.pressSequentially('/srv/models/qwen-browser.gguf');
      await expect(dialog.locator('code')).toHaveText('/srv/models/qwen-browser.gguf:/models/model.gguf:ro');
      await dialog.getByRole('combobox', { name: /^Compute/ }).selectOption('gpu');
      await expect(dialog.getByRole('textbox', { name: /^Dockerfile path/ })).toHaveValue('.devops/cuda.Dockerfile');
      await expect(dialog).toContainText('Hardware is not detected or verified.');
      await expect(dialog).toContainText('not your browser filesystem');
      await dialog.getByRole('textbox', { name: /^Environment variables/ }).fill('MODEL_LABEL=browser-only-value');
      await expectNoOverflow(page);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog).toContainText('refs/pull/12345/head');
      await expect(dialog).toContainText('Internal networking is shared, not isolated by space.');
      await expect(dialog).toContainText('MODEL_LABEL');
      await expect(dialog).not.toContainText('browser-only-value');
      await expect(dialog).toContainText('recreate');
      const runtime = JSON.parse((await dialog.locator('pre').textContent())!);
      expect(runtime).toEqual({ health_type: 'http', health_path: '/health', health_timeout_ms: 300000,
        entrypoint: ['/app/llama-server'],
        command: ['--model', '/models/model.gguf', '--host', '0.0.0.0', '--port', '8080', '--ctx-size', '4096', '--n-gpu-layers', '99'],
        host_config: { binds: ['/srv/models/qwen-browser.gguf:/models/model.gguf:ro'], gpus: 'all' } });
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('llama-review.png') });
      // A new step should start at its summary, not inherit the configuration scroll position.
      await expect.soft(dialog.getByRole('heading', { name: 'One last look.' })).toBeInViewport();
      await dialog.getByRole('button', { name: 'Create and deploy' }).click();
      await expect(dialog).toHaveCount(0);
      expect(standalone.creates).toHaveLength(1);
      expect(standalone.creates[0]).toMatchObject({ source_type: 'git', branch: 'refs/pull/12345/head', dockerfile_path: '.devops/cuda.Dockerfile', build_target: 'server', exposure: 'internal', deployment_strategy: 'recreate', volume_path: null, runtime_options: runtime });
      expect(standalone.creates[0]).not.toHaveProperty('repo_uid');
    });

    test('partial creation failure retains the ID and retries deployment without duplicate creation', async ({ page, standalone }) => {
      standalone.failDeploy = true;
      await page.getByRole('button', { name: 'Try PostgreSQL' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('textbox', { name: /^Service name/ }).fill('retry-db');
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await dialog.getByRole('button', { name: 'Create and deploy' }).click();
      await expect(dialog.getByRole('alert')).toContainText('was created, but deployment was not confirmed');
      await expect(dialog.getByRole('alert')).toContainText('Builder unavailable');
      await expect(dialog.getByRole('button', { name: 'Open created service' })).toBeEnabled();
      await expect(dialog.getByRole('button', { name: 'Back', exact: true })).toHaveCount(0);
      expect(standalone.creates).toHaveLength(1);
      expect(standalone.deployIds).toEqual([84]);
      await dialog.getByRole('alert').scrollIntoViewIfNeeded();
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('partial-creation.png') });
      await dialog.getByRole('button', { name: 'Retry deployment' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page).toHaveURL(/tab=deployments&service=84/);
      await expect(page.getByRole('region', { name: 'Selected service details' }).getByRole('heading', { name: 'retry-db' })).toBeVisible();
      expect(standalone.creates).toHaveLength(1);
      expect(standalone.deployIds).toEqual([84, 84]);
    });

    test('standalone selection and reload preserve canonical details and fetch fresh runtime logs', async ({ page, standalone }) => {
      await page.getByTestId('board-card-postgres').click();
      const detail = page.getByRole('region', { name: 'Selected service details' });
      await expect(detail.getByRole('heading', { name: 'postgres', exact: true })).toBeFocused();
      await expect(detail.getByRole('textbox', { name: 'Connection URI' })).toHaveValue('postgresql://USER:********@nixre-svc-42:5432/DATABASE');
      await expect(detail).toContainText('No backup configured.');
      await expect(detail).toContainText('No checks available');
      await detail.getByRole('button', { name: 'Deployments', exact: true }).click();
      await expect(detail.getByRole('button', { name: 'Upgrade version' })).toBeDisabled();
      await expect(detail.getByRole('button', { name: 'Rollback', exact: true })).toBeDisabled();
      await page.getByTestId('board-card-llama-server').click();
      await expect(detail.getByRole('heading', { name: 'llama-server' })).toBeVisible();
      await expect(detail).toContainText('/srv/models/model.gguf:/models/model.gguf:ro');
      await expect(page).toHaveURL(/tab=deployments&service=43/);
      await page.reload();
      await expect(detail.getByRole('heading', { name: 'llama-server' })).toBeVisible();
      await detail.getByRole('button', { name: 'Runtime logs' }).click();
      await expect(detail.locator('pre')).toContainText('Fixture service 43: runtime snapshot 1');
      await detail.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(detail.locator('pre')).toContainText('Fixture service 43: runtime snapshot 2');
      expect(standalone.requests).toContain(`GET ${servicesPath}/43/runtime-logs`);
      expect(standalone.requests).toContain(`GET ${servicesPath}/43/events`);
      await expectNoOverflow(page);
      await page.screenshot({ path: test.info().outputPath('standalone-runtime-logs.png'), fullPage: true });
    });
  });
}

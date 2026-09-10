import { test, expect, type Page } from '@playwright/test';

// Render the real production bundle with deterministic HTTP fixtures. jsdom
// cannot catch a CSS breakpoint silently ignoring a selected layout.
async function openRepository(page: Page) {
  const state = { layout: 'split', serviceLoads: 0 };
  await page.addInitScript(() => {
    localStorage.setItem('nixre_token', 'layout-test-session');
    localStorage.setItem('nixre_sync_migrated', '1');
  });
  await page.route('**/api/**', async route => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/v1/user') return json({ uid: 'jane', display_name: 'Jane', admin: true });
    if (path === '/api/sync/v1/prefs') return json({ repository_layout: state.layout });
    if (path === '/api/sync/v1/prefs/repository_layout') {
      state.layout = route.request().postDataJSON().value;
      return json({});
    }
    if (path.includes('/avatars/')) return route.fulfill({ status: 404 });
    if (path.endsWith('/+')) return json({ id: 1, uid: 'website', path: 'acme/website', description: 'Layout test repository', default_branch: 'main', is_public: true, can_write: true, num_open_pulls: 0 });
    if (path.endsWith('/branches')) return json({ branches: [{ name: 'main', sha: 'abc1234' }] });
    if (path.includes('/+/content')) return json({ content: { entries: (path.endsWith('/content')
      ? [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }]
      : [{ name: 'app.ts', type: 'file' }]).map(entry => ({ ...entry, path: entry.name, sha: 'abc1234' })) } });
    if (path.includes('/+/raw')) return route.fulfill({ contentType: 'text/plain', body: '# Repository preview\n\nRead the source alongside your deployments.' });
    if (path.endsWith('/commits')) return json({ commits: [] });
    if (path.endsWith('/deployments/services')) {
      state.serviceLoads++;
      return json([{ id: 12, name: 'web', status: 'running', desired_state: 'running', root_dir: '.', dockerfile_path: 'Dockerfile', container_port: 3000, branch: 'main', auto_deploy: true, cpu_nano_cpus: 1e9, memory_bytes: 536870912 }]);
    }
    if (path.endsWith('/uptime')) return json({ buckets: [], uptime_pct: 100, checks_total: 0 });
    if (path.endsWith('/stats')) return json({ latest: null, series: [], limits: { memory_bytes: 536870912 } });
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: '' });
    return json([]);
  });
  await page.goto('/acme/website');
  await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'View service web', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Repository preview', exact: true })).toBeVisible();
  return state;
}

async function geometry(page: Page) {
  const tree = (await page.locator('.repo-workspace-tree').boundingBox())!;
  const preview = (await page.locator('.repo-workspace-preview').boundingBox())!;
  const deployments = (await page.locator('.repo-workspace-deployments').boundingBox())!;
  return { tree, preview, deployments };
}

for (const width of [1440, 1279, 1100, 1024, 900, 768, 390]) {
  test(`all four layouts visibly rearrange the workspace at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = await openRepository(page);
    let { tree, preview, deployments } = await geometry(page);
    if (width >= 1024) {
      expect(tree.x).toBeLessThan(deployments.x);
      expect(Math.abs(tree.y - deployments.y)).toBeLessThan(3);
      expect(preview.y).toBeGreaterThan(tree.y + tree.height);
    } else {
      expect(tree.y).toBeLessThan(deployments.y);
      expect(deployments.y).toBeLessThan(preview.y);
    }
    if (width === 1440) await page.screenshot({ path: test.info().outputPath('split.png'), fullPage: true });

    const selector = page.getByLabel('Repository layout', { exact: true });
    await selector.selectOption('columns');
    await expect(page.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'columns');
    ({ tree, preview, deployments } = await geometry(page));
    expect(tree.x).toBeLessThan(preview.x);
    expect(preview.x).toBeLessThan(deployments.x);
    expect(Math.abs(tree.y - preview.y)).toBeLessThan(3);
    expect(Math.abs(tree.y - deployments.y)).toBeLessThan(3);
    if (width <= 768) {
      expect(await page.locator('.repo-workspace-viewport').evaluate(el => el.scrollWidth > el.clientWidth)).toBe(true);
    }
    if (width === 1440) await page.screenshot({ path: test.info().outputPath('columns.png'), fullPage: true });

    await selector.selectOption('preview-left');
    await expect(page.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'preview-left');
    ({ tree, preview, deployments } = await geometry(page));
    if (width >= 768) {
      expect(preview.x).toBeLessThan(tree.x);
      expect(Math.abs(tree.x - deployments.x)).toBeLessThan(3);
      expect(tree.y).toBeLessThan(deployments.y);
    } else {
      expect(preview.y).toBeLessThan(tree.y);
      expect(tree.y).toBeLessThan(deployments.y);
    }
    if (width === 1440) await page.screenshot({ path: test.info().outputPath('preview-left.png'), fullPage: true });

    await selector.selectOption('stacked');
    await expect(page.getByTestId('repository-workspace')).toHaveAttribute('data-layout', 'stacked');
    ({ tree, preview, deployments } = await geometry(page));
    expect(Math.abs(tree.x - preview.x)).toBeLessThan(3);
    expect(Math.abs(preview.x - deployments.x)).toBeLessThan(3);
    expect(tree.y).toBeLessThan(preview.y);
    expect(preview.y).toBeLessThan(deployments.y);
    if (width === 1440) await page.screenshot({ path: test.info().outputPath('stacked.png'), fullPage: true });
    expect(state.serviceLoads).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  });
}

for (const layout of ['preview-left', 'stacked']) {
  test(`${layout} is saved and restored across reloads`, async ({ page }) => {
    const state = await openRepository(page);
    await page.getByLabel('Repository layout', { exact: true }).selectOption(layout);
    await expect.poll(() => state.layout).toBe(layout);
    await page.reload();
    await expect(page.getByLabel('Repository layout', { exact: true })).toHaveValue(layout);
    await expect(page.getByTestId('repository-workspace')).toHaveAttribute('data-layout', layout);
  });
}

test('switching all four layouts preserves expanded folders and file drafts', async ({ page }) => {
  await openRepository(page);
  await page.getByRole('treeitem', { name: 'src', exact: true }).click();
  await expect(page.getByRole('treeitem', { name: 'app.ts', exact: true })).toBeVisible();
  await page.getByRole('treeitem', { name: 'README.md', exact: true }).click();
  await page.getByTitle('Edit this file', { exact: true }).click();
  await page.getByLabel('File contents', { exact: true }).fill('Unsaved draft');
  for (const layout of ['columns', 'preview-left', 'stacked', 'split']) {
    await page.getByLabel('Repository layout', { exact: true }).selectOption(layout);
    await expect(page.getByLabel('File contents', { exact: true })).toHaveValue('Unsaved draft');
    await expect(page.getByRole('treeitem', { name: 'src', exact: true })).toHaveAttribute('aria-expanded', 'true');
  }
});

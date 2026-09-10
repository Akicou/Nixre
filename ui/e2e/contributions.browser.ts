import { test, expect, type Page } from '@playwright/test';

const counts = [0, 1, 3, 6, 7];

async function openContributions(page: Page, personal: boolean) {
  await page.addInitScript(() => {
    localStorage.setItem('nixre_token', 'contribution-test-session');
    localStorage.setItem('nixre_sync_migrated', '1');
  });
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (value: unknown) => route.fulfill({ json: value });
    if (path === '/api/v1/user') return json({ uid: 'jane', display_name: 'Jane', admin: false });
    if (path === '/api/v1/spaces/acme') return json({ id: 1, uid: 'acme', path: 'acme', description: 'Contribution graph test', is_public: true, is_personal: personal, created: 1735689600000 });
    if (path === '/api/v1/users/acme') return json({ uid: 'acme', display_name: 'Acme', created: 1735689600000, socials: [], orgs: [], is_self: false });
    if (path.endsWith('/contributions')) {
      const year = Number(url.searchParams.get('year'));
      return json({ year, total: 17, days: counts.map((count, i) => ({ date: `${year}-01-0${i + 1}`, count })) });
    }
    return json([]);
  });
  await page.goto('/acme');
  await expect(page.getByRole('heading', { name: /17 contributions in/ })).toBeVisible();
}

async function contributionColors(page: Page) {
  return Promise.all(counts.map((count, i) => page.getByTitle(new RegExp(`^${count} contribution[s]? on Jan ${i + 1},`))
    .evaluate(element => getComputedStyle(element).backgroundColor)));
}

function expectOpaqueGreenScale(colors: string[]) {
  expect(colors).toHaveLength(5);
  expect(new Set(colors).size, `contribution colors: ${colors.join('; ')}`).toBe(5);
  for (const [level, color] of colors.entries()) {
    const [red, green, blue, alpha = 1] = color.match(/[\d.]+/g)!.map(Number);
    expect(alpha, `contribution level ${level}: ${color}`).toBe(1);
    if (level > 0) {
      expect(green, `green channel at level ${level}`).toBeGreaterThan(red);
      expect(green, `green channel at level ${level}`).toBeGreaterThan(blue);
    }
  }
}

for (const personal of [false, true]) {
  test(`contributions use visible green intensity levels on ${personal ? 'personal profiles' : 'organization pages'} in both themes`, async ({ page }) => {
    await openContributions(page, personal);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      const colors = await contributionColors(page);
      expectOpaqueGreenScale(colors);
      const legendColors = await page.getByText('Less', { exact: true }).locator('..').locator('span')
        .evaluateAll(elements => elements.slice(1, -1).map(element => getComputedStyle(element).backgroundColor));
      expect(legendColors).toEqual(colors);
      await page.screenshot({ path: test.info().outputPath(`contributions-${theme}.png`), fullPage: true });
    }
    // Changing the year uses the same color scale with newly rendered cells.
    await page.getByRole('button', { name: '2025', exact: true }).click();
    await expect(page.getByRole('heading', { name: '17 contributions in 2025' })).toBeVisible();
    expectOpaqueGreenScale(await contributionColors(page));
  });
}

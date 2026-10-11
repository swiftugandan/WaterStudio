import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function setTheme(page: Page, theme: 'Light' | 'Dark') {
  await page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: theme }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme.toLowerCase());
}

test('the engine solves Net1 in a worker with EPANET-identical results', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Run hydraulics' }).click();
  await expect(page.getByTestId('engine-summary')).toContainText(
    'Solved Net1.inp: 11 nodes, 13 links, 25 report periods',
  );
  // OWA-EPANET 2.3.5 gives node 10 a head of 1004.3473918938504 ft at 0:00.
  const row = page.getByTestId('node-table').getByRole('row', { name: /^10 / });
  await expect(row).toContainText('1,004.347');
  await page.getByRole('slider').fill('12');
  await expect(page.getByTestId('period-time')).toHaveText('12:00');
});

test('engine errors are reported, not thrown', async ({ page }) => {
  await page.route('**/samples/Net1.inp', (r) => r.fulfill({ body: '[JUNCTIONS]\n J1 0 1\n[END]\n' }));
  await page.goto('/');
  await page.getByRole('button', { name: 'Run hydraulics' }).click();
  await expect(page.getByRole('status')).toContainText('Engine error');
});

test('every symbol and icon renders', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('list', { name: 'Engineering symbols' }).getByRole('listitem')).toHaveCount(19);
  const icons = page.getByRole('list', { name: 'Hydraulic icons' }).getByRole('listitem');
  expect(await icons.count()).toBeGreaterThan(30);
});

test('theme and density persist across reloads', async ({ page }) => {
  await page.goto('/');
  await setTheme(page, 'Dark');
  await page.getByRole('radiogroup', { name: 'Density' }).getByRole('radio', { name: 'Compact' }).click();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
});

for (const theme of ['Light', 'Dark'] as const) {
  test(`no WCAG 2.2 AA violations in the ${theme.toLowerCase()} theme`, async ({ page }) => {
    await page.goto('/');
    await setTheme(page, theme);
    await page.getByRole('button', { name: 'Run hydraulics' }).click();
    await expect(page.getByTestId('engine-summary')).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`)).toEqual([]);
  });
}

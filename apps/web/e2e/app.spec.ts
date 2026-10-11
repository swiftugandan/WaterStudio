import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

interface WS {
  state: {
    store: {
      doc: {
        findNode(id: string): number | undefined;
        nodes: { liveCount: number };
        links: { liveCount: number };
        num(h: number, f: string): number;
      };
    };
    view: { screenOf(h: number): [number, number] | null; fit(): void } | null;
    selection: Set<number>;
    run: { status: string };
    renderer: { backend: string | null };
    messages: { level: string; text: string }[];
  };
}

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('renderer')).not.toHaveText('Starting renderer…');
  await expect(page.locator('.statusbar')).toContainText('11 nodes · 13 links');
}

async function nodeOnScreen(page: Page, id: string): Promise<{ x: number; y: number }> {
  const p = await page.evaluate((nid) => {
    const ws = (globalThis as unknown as { waterstudio: WS }).waterstudio;
    const h = ws.state.store.doc.findNode(nid);
    return h === undefined ? null : (ws.state.view?.screenOf(h) ?? null);
  }, id);
  if (!p) throw new Error(`node ${id} not on screen`);
  const box = (await page.locator('.map-overlay').boundingBox())!;
  return { x: box.x + p[0], y: box.y + p[1] };
}

/** Evaluate `fn` in the page with the app's state and command bus. */
const ws = <T>(page: Page, fn: (w: WS) => T): Promise<T> =>
  page.evaluate(
    // The function's source is ours, from this file; evaluating it is how Playwright works anyway.
    (src) =>
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      (new Function('w', `return (${src})(w);`) as (w: unknown) => T)(
        (globalThis as unknown as { waterstudio: unknown }).waterstudio,
      ),
    fn.toString(),
  );

test('opens Net1, runs it, and shows EPANET-identical results', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  // OWA-EPANET 2.3.5 gives node 10 a head of 1004.347 ft at 0:00.
  await expect(page.locator('.results .grid-row', { hasText: /^10/ }).first()).toContainText('1004.35');
  await expect(page.getByLabel('Map legend')).toContainText('Node pressure');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('slider', { name: 'Report time' }).fill('12');
  await expect(page.getByTestId('report-time')).toHaveText('12:00');
  // No renderer errors, whichever backend runs.
  const errors = await ws(page, (w) =>
    w.state.messages.filter((m) => m.level === 'error').map((m) => m.text),
  );
  expect(errors).toEqual([]);
});

test('selects on the map, edits in the inspector, and undoes', async ({ page }) => {
  await ready(page);
  const p = await nodeOnScreen(page, '22');
  await page.mouse.click(p.x, p.y);
  await expect(page.locator('.properties .panel-title')).toHaveText('Junction 22');
  const elev = page.locator('.properties').getByLabel('Elevation');
  await expect(elev).toHaveValue('695');
  await elev.fill('700');
  await elev.press('Enter');
  await expect(page.locator('.statusbar')).toContainText('Net1.inp •');
  await page.keyboard.press('Control+z');
  await expect(elev).toHaveValue('695');
  await elev.fill('-x');
  await elev.press('Enter');
  await expect(page.locator('.properties [role=alert]')).toContainText('must be a number');
});

test('draws a network from scratch', async ({ page }) => {
  await ready(page);
  page.on('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'New network' }).click();
  await expect(page.locator('.statusbar')).toContainText('0 nodes · 0 links');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  const m = (await page.locator('.map-overlay').boundingBox())!;
  // Points as fractions of the map.
  const box = { x: m.x, y: m.y };
  const X = (f: number) => (f * m.width) / 600;
  const Y = (f: number) => (f * m.height) / 450;
  await page.getByRole('button', { name: 'Add reservoir' }).click();
  await page.mouse.click(box.x + X(200), box.y + Y(200));
  await page.getByRole('button', { name: 'Add junction' }).click();
  await page.mouse.click(box.x + X(400), box.y + Y(200));
  await page.mouse.click(box.x + X(400), box.y + Y(350));
  await expect(page.locator('.statusbar')).toContainText('3 nodes · 0 links');
  await page.getByRole('button', { name: 'Add pipe' }).click();
  await page.mouse.click(box.x + X(200), box.y + Y(200));
  await page.mouse.click(box.x + X(400), box.y + Y(200));
  await page.mouse.click(box.x + X(400), box.y + Y(200));
  await page.mouse.click(box.x + X(300), box.y + Y(300)); // a vertex
  await page.mouse.click(box.x + X(400), box.y + Y(350));
  await expect(page.locator('.statusbar')).toContainText('3 nodes · 2 links');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  // Moving a node is one undoable step.
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  await page.mouse.move(box.x + X(400), box.y + Y(350));
  await page.mouse.down();
  await page.mouse.move(box.x + X(450), box.y + Y(380), { steps: 5 });
  await page.mouse.up();
  await expect(page.getByTestId('run-status')).toContainText('out of date');
  await page.keyboard.press('Delete');
  await expect(page.locator('.statusbar')).toContainText('2 nodes · 1 links');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.statusbar')).toContainText('3 nodes · 2 links');
});

test('selects by window and runs commands from the palette', async ({ page }) => {
  await ready(page);
  const a = await nodeOnScreen(page, '21');
  const b = await nodeOnScreen(page, '32');
  await page.mouse.move(Math.min(a.x, b.x) - 10, Math.min(a.y, b.y) - 10);
  await page.mouse.down();
  await page.mouse.move(Math.max(a.x, b.x) + 10, Math.max(a.y, b.y) + 10, { steps: 4 });
  await page.mouse.up();
  const n = await ws(page, (w) => w.state.selection.size);
  expect(n).toBeGreaterThanOrEqual(4);
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('theme dark');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

for (const theme of ['light', 'dark'] as const) {
  test(`no WCAG 2.2 AA violations in the ${theme} theme`, async ({ page }) => {
    await ready(page);
    await page.evaluate((t) => localStorage.setItem('ws.theme', t), theme);
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('F5');
    await expect(page.getByTestId('run-status')).toContainText('Solved');
    const results = await new AxeBuilder({ page })
      // dockview renders each tab's close button inside the tab (nested-interactive);
      // tracked upstream, and every panel can also be closed from the View tab.
      .exclude('.dv-tabs-container')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  });
}

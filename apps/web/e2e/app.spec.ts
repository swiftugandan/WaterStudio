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

// Tests never load OpenStreetMap's tile servers; a test may route them itself.
test.beforeEach(async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }));
});

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
  // Net1 models chlorine; OWA-EPANET gives node 22 0.568 mg/L at 12:00.
  await expect(page.locator('.results .grid-header')).toContainText('Quality mg/L');
  await expect(page.locator('.results .grid-row', { hasText: /^22/ }).first()).toContainText('0.57');
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

test('graphs results over time, along a path and as a distribution', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  const ribbon = page.getByRole('tablist', { name: 'Ribbon' });
  await ribbon.getByRole('tab', { name: 'Results' }).click();
  const a = await nodeOnScreen(page, '10');
  const b = await nodeOnScreen(page, '22');
  await page.mouse.click(a.x, a.y);
  await page.keyboard.down('Shift');
  await page.mouse.click(b.x, b.y);
  await page.keyboard.up('Shift');
  await page.getByRole('button', { name: 'Time series' }).click();
  const series = page.locator('.panel.graph figure').first();
  await expect(series.locator('figcaption')).toContainText('Pressure: 10, 22');
  await expect(series.getByRole('img')).toBeVisible();
  await page.locator('.panel.graph').first().getByRole('button', { name: 'Table' }).click();
  // Net1 reports 25 periods.
  await expect(series.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.locator('.panel.graph figcaption', { hasText: 'Head profile at' })).toBeVisible();
  await page.getByRole('button', { name: 'Frequency' }).click();
  await expect(
    page.locator('.panel.graph figcaption', { hasText: 'Distribution of pressure' }),
  ).toBeVisible();
});

test('shows EPANET reports and offers the files', async ({ page }) => {
  await ready(page);
  const ribbon = page.getByRole('tablist', { name: 'Ribbon' });
  await ribbon.getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Reports' }).click();
  const report = page.locator('.panel.report');
  await expect(report.locator('.report-text')).toContainText('Balanced after 4 trials');
  await report.getByRole('tab', { name: 'Energy' }).click();
  await expect(report.locator('table')).toContainText('Total cost');
  await report.getByRole('tab', { name: 'Reaction' }).click();
  await expect(report.locator('table')).toContainText('Bulk (pipes)');
  await report.getByRole('tab', { name: 'Full report' }).click();
  await expect(report.locator('.report-text')).toContainText('Analysis begun');
  const download = page.waitForEvent('download');
  await report.getByRole('button', { name: 'Download .out' }).click();
  expect((await download).suggestedFilename()).toBe('Net1.out');
});

test('puts the network on a street map once it has a coordinate system', async ({ page }) => {
  // Serve tiles locally: tests must not load the OpenStreetMap servers.
  let tiles = 0;
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  );
  await page.route('https://tile.openstreetmap.org/**', (route) => {
    tiles++;
    return route.fulfill({ status: 200, contentType: 'image/png', body: png });
  });
  await ready(page);
  await expect(page.locator('.statusbar')).toContainText('No CRS');
  await expect(page.locator('.map-attribution')).toHaveCount(0);
  page.on('dialog', (d) => void d.accept('EPSG:32633'));
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Set coordinate system' }).click();
  await expect(page.locator('.statusbar')).toContainText('EPSG:32633');
  await expect(page.locator('.map-attribution')).toContainText('OpenStreetMap');
  await expect(page.locator('.basemap canvas')).toBeVisible();
  await expect.poll(() => tiles).toBeGreaterThan(0);
  // The coordinate system is part of the model: undo removes it.
  await page.keyboard.press('Control+z');
  await expect(page.locator('.statusbar')).toContainText('No CRS');
  await expect(page.locator('.map-attribution')).toHaveCount(0);
});

test('shows a backdrop image where [BACKDROP] places it', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'View' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Load backdrop image' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'aerial.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    ),
  });
  const img = page.locator('img.backdrop');
  await expect(img).toBeVisible();
  const box = (await img.boundingBox())!;
  expect(box.width).toBeGreaterThan(50);
  // Net1's [BACKDROP] already gives DIMENSIONS; the file name is recorded with them.
  const backdrop = await ws(page, (w) =>
    (
      w.state.store.doc as unknown as { data: { backdrop: { lines: { tokens: string[] }[] } } }
    ).data.backdrop.lines.map((l) => l.tokens.join(' ')),
  );
  expect(backdrop).toContain('FILE aerial.png');
  await page.getByRole('button', { name: 'Remove backdrop image' }).click();
  await expect(img).toBeHidden();
});

test('imports GeoJSON into a projected network and exports GeoJSON and DXF', async ({ page }) => {
  await ready(page);
  page.on('dialog', (d) => void d.accept());
  const geojson = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-0.1276, 51.5072] },
        properties: { id: 'SRC', type: 'reservoir', head: 60 },
      },
      {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [-0.1256, 51.5079, 12] },
        properties: { id: 'J1', demand: 2 },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.1276, 51.5072],
            [-0.1266, 51.508],
            [-0.1256, 51.5079],
          ],
        },
        properties: { id: 'P1', diameter: 150 },
      },
      {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: [
            [-0.1256, 51.5079],
            [-0.1246, 51.5085],
          ],
        },
        properties: { id: 'P2' },
      },
    ],
  };
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import GeoJSON or DXF' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'mains.geojson',
    mimeType: 'application/geo+json',
    buffer: Buffer.from(JSON.stringify(geojson)),
  });
  // London is in UTM zone 30N; the open end of P2 got a junction.
  await expect(page.locator('.statusbar')).toContainText('3 nodes · 2 links');
  await expect(page.locator('.statusbar')).toContainText('EPSG:32630');
  await expect(page.locator('.statusbar')).toContainText('mains.inp');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  const geo = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export GeoJSON' }).click();
  expect((await geo).suggestedFilename()).toBe('mains.geojson');
  const dxf = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export DXF' }).click();
  expect((await dxf).suggestedFilename()).toBe('mains.dxf');
});

for (const theme of ['light', 'dark'] as const) {
  test(`no WCAG 2.2 AA violations in the ${theme} theme`, async ({ page }) => {
    await ready(page);
    await page.evaluate((t) => localStorage.setItem('ws.theme', t), theme);
    await ready(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await page.keyboard.press('F5');
    await expect(page.getByTestId('run-status')).toContainText('Solved');
    // With a graph and the reports open too.
    await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
    await page.getByRole('button', { name: 'System flow' }).click();
    await expect(page.locator('.panel.graph figure')).toBeVisible();
    await page.getByRole('button', { name: 'Reports' }).click();
    await expect(page.locator('.panel.report .report-text')).toBeVisible();
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

import { readFile } from 'node:fs/promises';
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
        get(h: number, f: string): unknown;
        data: {
          options: { lines: { tokens: string[] }[] };
          times: { lines: { tokens: string[] }[] };
          patterns: { id: string; multipliers: number[] }[];
          controls: { tokens: string[] }[];
        };
      };
      undo(): boolean;
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
  // Graph options: a title and axis limits of one's own.
  const graph = page.locator('.panel.graph').first();
  await graph.getByRole('button', { name: 'Options' }).click();
  await graph.getByLabel('Title').fill('Pressure at two junctions');
  await graph.getByLabel('Y from').fill('100');
  await graph.getByLabel('Y to').fill('140');
  await graph.getByLabel('Y to').blur();
  await expect(series.locator('figcaption')).toHaveText('Pressure at two junctions');
  const yLabels = await series.locator('.chart-axis text[text-anchor="end"]').allTextContents();
  expect([yLabels[0], yLabels.at(-1)]).toEqual(['100', '140']);
  await page.locator('.panel.graph').first().getByRole('button', { name: 'Table' }).click();
  // Net1 reports 25 periods.
  await expect(series.locator('tbody tr')).toHaveCount(25);
  await page.getByRole('button', { name: 'Profile' }).click();
  await expect(page.locator('.panel.graph figcaption', { hasText: 'Head profile at' })).toBeVisible();
  await page.getByRole('button', { name: 'Frequency' }).click();
  await expect(
    page.locator('.panel.graph figcaption', { hasText: 'Distribution of pressure' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Contour' }).click();
  const contour = page.locator('.panel.graph').filter({ has: page.locator('figure.contour') });
  await expect(contour.getByRole('img')).toHaveAttribute('aria-label', /Pressure at 0:00\. .* nodes/);
  await contour.getByRole('button', { name: 'Table' }).click();
  // Every node is in one band.
  const counts = await contour.locator('tbody td').allTextContents();
  expect(counts.reduce((a, c) => a + Number(c), 0)).toBe(11);
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

test('compares measurements with the simulation in a calibration report', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Reports' }).click();
  const report = page.locator('.panel.report');
  await report.getByRole('tab', { name: 'Calibration' }).click();
  await report.getByLabel('Variable').selectOption('pressure');
  const chooser = page.waitForEvent('filechooser');
  await report.getByRole('button', { name: 'Load measurements…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'pressure.dat',
    mimeType: 'text/plain',
    buffer: Buffer.from(';Net1 pressures\n10  0  128\n    6  120\n22  0:00  118\nXX  1  50\n'),
  });
  const table = report.locator('.calibration-table');
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('tfoot')).toContainText('Network3');
  await expect(report).toContainText('Correlation between means');
  await expect(report.getByRole('status')).toContainText('No node called XX');
  await expect(report.locator('.calibration-chart figure')).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .include('.panel.report')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
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
  // Align it by dragging: the image follows, and the shift is saved as OFFSET.
  await page.getByRole('button', { name: 'Align backdrop' }).click();
  const map = (await page.locator('.map-overlay').boundingBox())!;
  const from = { x: map.x + map.width / 2, y: map.y + map.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await img.boundingBox())!.x - box.x).toBeCloseTo(30, 0);
  const offset = await ws(page, (w) =>
    (
      w.state.store.doc as unknown as { data: { backdrop: { lines: { tokens: string[] }[] } } }
    ).data.backdrop.lines
      .find((l) => l.tokens[0] === 'OFFSET')
      ?.tokens.slice(1)
      .map(Number),
  );
  expect(offset![0]).toBeGreaterThan(0);
  expect(offset![1]).toBeCloseTo(0, 6);
  // Or without dragging: click a point, then where it belongs.
  const moved = (await img.boundingBox())!.x;
  await page.mouse.click(from.x, from.y);
  await page.mouse.click(from.x + 20, from.y);
  await expect.poll(async () => (await img.boundingBox())!.x - moved).toBeCloseTo(20, 0);
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
  await page.getByRole('button', { name: 'Import GeoJSON, shapefile or DXF' }).click();
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
  // Shapefiles in longitude and latitude come back into the same zone.
  const shp = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export shapefiles' }).click();
  const zip = await shp;
  expect(zip.suggestedFilename()).toBe('mains_shp.zip');
  const bytes = await readFile(await zip.path());
  page.once('dialog', (d) => void d.accept());
  const again = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import GeoJSON, shapefile or DXF' }).click();
  await (await again).setFiles({ name: 'mains_shp.zip', mimeType: 'application/zip', buffer: bytes });
  await expect(page.locator('.statusbar')).toContainText('mains_shp.inp');
  await expect(page.locator('.statusbar')).toContainText('3 nodes · 2 links');
  await expect(page.locator('.statusbar')).toContainText('EPSG:32630');
});

test('the assistant answers with tools, showing each call', async ({ page }) => {
  // A scripted model: run the analysis, look at pressures, then answer.
  const bodies: { messages: { role: string; content: { type: string; content?: string }[] }[] }[] = [];
  const replies = [
    { content: [{ type: 'tool_use', id: 't1', name: 'run_analysis', input: {} }], stop_reason: 'tool_use' },
    {
      content: [
        {
          type: 'tool_use',
          id: 't2',
          name: 'get_results_slice',
          input: { variable: 'pressure', top: 1, types: ['junction'] },
        },
      ],
      stop_reason: 'tool_use',
    },
    { content: [{ type: 'text', text: 'The lowest pressure is at junction 32.' }], stop_reason: 'end_turn' },
  ];
  await page.route('https://api.anthropic.com/v1/messages', async (route) => {
    bodies.push(route.request().postDataJSON() as (typeof bodies)[number]);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(replies.shift()),
    });
  });
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Analysis' }).click();
  await page.getByRole('button', { name: 'Show assistant' }).click();
  const panel = page.locator('.panel.assistant');
  await panel.getByRole('textbox', { name: 'Message to the assistant' }).fill('Where is pressure lowest?');
  await panel.getByRole('button', { name: 'Send' }).click();
  await expect(panel.getByRole('log')).toContainText('The lowest pressure is at junction 32.');
  await expect(panel.locator('.assistant-tool')).toHaveCount(2);
  await expect(panel.locator('.assistant-tool').first()).toContainText('Used run_analysis');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  // The model got the engine's numbers back as tool results.
  const last = bodies[2]!.messages.at(-1)!.content[0]!;
  expect(JSON.parse(last.content!)).toMatchObject({ variable: 'pressure', lowest: [{ id: '32' }] });
});

/** The [OPTIONS] line starting with `key`, as text. */
const option = (page: Page, key: string) =>
  page.evaluate((k) => {
    const w = (globalThis as unknown as { waterstudio: WS }).waterstudio;
    return w.state.store.doc.data.options.lines
      .find((l) => l.tokens[0]!.toUpperCase() === k)
      ?.tokens.join(' ');
  }, key);

test('edits project options with undo', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Show options' }).click();
  const panel = page.locator('.panel.options');
  await panel.getByLabel('Maximum trials').fill('50');
  await panel.getByLabel('Maximum trials').press('Enter');
  expect(await option(page, 'TRIALS')).toBe('TRIALS 50');
  await panel.getByLabel('Accuracy').fill('lots');
  await panel.getByLabel('Accuracy').press('Enter');
  await expect(panel.getByRole('alert')).toHaveText('Accuracy must be a number.');
  await panel.getByLabel('Accuracy').press('Escape');
  await panel.getByRole('tab', { name: 'Quality' }).click();
  await expect(panel.getByLabel('Chemical name')).toHaveValue('Chlorine');
  await panel.getByLabel('Analysis').selectOption('age');
  expect(await option(page, 'QUALITY')).toBe('QUALITY AGE');
  await expect(panel.getByLabel('Chemical name')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  expect(await option(page, 'QUALITY')).toBe('Quality Chlorine mg/L'); // Net1's own line
  await panel.getByRole('tab', { name: 'Times' }).click();
  await expect(panel.getByLabel('Total duration')).toHaveValue('24:00');
  await panel.getByLabel('Total duration').fill('48');
  await panel.getByLabel('Total duration').press('Enter');
  await expect(panel.getByLabel('Total duration')).toHaveValue('48:00');
  await panel.getByRole('tab', { name: 'Summary' }).click();
  await expect(panel.getByLabel('Title and notes')).toHaveValue(/EPANET Example Network 1/);
  await expect(panel.getByRole('region', { name: 'Project summary' })).toContainText('Junctions9');
  // Defaults: new pipes get the prefix and diameter set here.
  await panel.getByRole('tab', { name: 'Defaults' }).click();
  await panel.getByLabel('Pipe', { exact: true }).fill('P-');
  await panel.getByLabel('Pipe', { exact: true }).press('Enter');
  await panel.getByLabel('Pipe diameter').fill('8');
  await panel.getByLabel('Pipe diameter').press('Enter');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Show add element' }).click();
  const add = page.locator('.panel.add-element');
  await add.getByLabel('Type').selectOption('pipe');
  await add.getByLabel('Start node').fill('10');
  await add.getByLabel('End node').fill('23');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByRole('status')).toHaveText('Added pipe P-14.');
  expect(
    await ws(page, (w) => {
      const d = w.state.store.doc as unknown as {
        findLink(id: string): number;
        num(h: number, f: string): number;
      };
      return d.num(d.findLink('P-14'), 'diameter');
    }),
  ).toBe(8);
});

test('edits patterns and curves, renaming every reference', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Show patterns' }).click();
  const pats = page.locator('.panel.data-editor');
  await expect(pats.getByRole('combobox', { name: 'Pattern' })).toHaveValue('1');
  await expect(pats.locator('.value-grid tbody tr')).toHaveCount(12);
  await pats.getByLabel('Multiplier 1', { exact: true }).fill('2');
  await pats.getByLabel('Multiplier 1', { exact: true }).press('Enter');
  expect(await ws(page, (w) => w.state.store.doc.data.patterns[0]!.multipliers[0])).toBe(2);
  await pats.getByLabel('ID', { exact: true }).fill('BASE');
  await pats.getByLabel('ID', { exact: true }).press('Enter');
  expect(await ws(page, (w) => w.state.store.doc.data.patterns[0]!.id)).toBe('BASE');
  // Net1's PATTERN option named pattern 1; it follows the rename.
  expect(await option(page, 'PATTERN')).toBe('PATTERN BASE');
  await pats.getByRole('button', { name: 'Delete' }).click();
  await expect(pats.getByRole('alert')).toContainText('Pattern BASE is used by');
  await pats.getByRole('button', { name: 'Edit as text' }).click();
  await pats.getByRole('textbox', { name: /Multipliers of pattern BASE/ }).fill('1\n2\n3');
  await pats.getByRole('button', { name: 'Edit as text' }).click();
  await expect(pats.locator('.value-grid tbody tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'Show curves' }).click();
  const curves = page.locator('.panel.data-editor').filter({ hasText: 'Curve' });
  await expect(curves.getByLabel('Type')).toContainText('used as pump (head)');
  // One point: EPANET fits h = 4/3·h0 − b·q².
  await expect(curves).toContainText('Head = 333.3 − 3.704e-5 × Flow');
});

test('edits controls and rules, refusing what EPANET would refuse', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Show controls' }).click();
  const panel = page.locator('.panel.controls-editor');
  const editor = panel.getByRole('textbox', { name: 'Simple controls, one per line' });
  await expect(editor).toHaveValue(/LINK 9 OPEN IF NODE 2 BELOW 110/);
  await editor.press('Control+End');
  await editor.pressSequentially('\nLINK 99 CLOSED AT TIME 2');
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByRole('alert')).toContainText('undefined link 99');
  expect(await ws(page, (w) => w.state.store.doc.data.controls.length)).toBe(2);
  await editor.fill((await editor.inputValue()).replace('LINK 99', 'LINK 10'));
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByRole('status')).toHaveText('3 controls applied.');
  expect(await ws(page, (w) => w.state.store.doc.data.controls[2]!.tokens.join(' '))).toBe(
    'LINK 10 CLOSED AT TIME 2',
  );
  await panel.getByRole('tab', { name: 'Rules' }).click();
  const rules = panel.getByRole('textbox', { name: 'Rule-based controls' });
  await rules.fill('RULE 1\nIF TANK 2 LEVEL ABOVE 140\nTHEN PUMP 9 STATUS IS CLOSED');
  await panel.getByRole('button', { name: 'Apply' }).click();
  await expect(panel.getByRole('status')).toHaveText('1 rule applied.');
});

test('edits demand categories, sources and tank mixing in the inspector', async ({ page }) => {
  await ready(page);
  await ws(page, (w) => {
    w.state.selection.clear();
    w.state.selection.add(w.state.store.doc.findNode('22')!);
    (w.state as unknown as { emit(): void }).emit();
  });
  const props = page.locator('.panel.properties');
  await expect(props.getByLabel('Base demand 1')).toHaveValue('200');
  await props.getByRole('button', { name: 'Add demand category' }).click();
  await props.getByLabel('Base demand 2').fill('15');
  await props.getByLabel('Base demand 2').press('Enter');
  await props.getByLabel('Pattern of demand 2').selectOption('1');
  expect(await ws(page, (w) => w.state.store.doc.get(w.state.store.doc.findNode('22')!, 'demands'))).toEqual([
    { base: 200, pattern: null, category: null },
    { base: 15, pattern: '1', category: null },
  ]);
  await props.getByLabel('Source type').selectOption('setpoint');
  await props.getByLabel('Source strength').fill('0.8');
  await props.getByLabel('Source strength').press('Enter');
  expect(
    await ws(page, (w) => JSON.stringify(w.state.store.doc.get(w.state.store.doc.findNode('22')!, 'source'))),
  ).toBe('{"kind":"setpoint","strength":0.8,"pattern":null}');
  await ws(page, (w) => {
    w.state.selection.clear();
    w.state.selection.add(w.state.store.doc.findNode('2')!);
    (w.state as unknown as { emit(): void }).emit();
  });
  await props.getByLabel('Mixing model').selectOption('twoComp');
  await expect(props.getByLabel('Mixing fraction')).toHaveValue('1');
  await props.getByLabel('Mixing fraction').fill('0.4');
  await props.getByLabel('Mixing fraction').press('Enter');
  expect(
    await ws(page, (w) => JSON.stringify(w.state.store.doc.get(w.state.store.doc.findNode('2')!, 'mixing'))),
  ).toBe('{"model":"twoComp","fraction":0.4}');
});

test('finds, queries, group-edits, and filters the results table', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('Control+f');
  const panel = page.locator('.panel.query');
  await expect(panel.getByLabel('Node or link ID')).toBeFocused();
  await page.keyboard.type('23');
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('status')).toHaveText('Found junction 23.');
  expect(
    await ws(page, (w) => [...w.state.selection].map((h) => w.state.store.doc.findNode('23') === h)),
  ).toEqual([true]);
  await panel.getByLabel('Attribute').selectOption('elevation');
  await panel.getByLabel('Relation').selectOption('equal');
  await panel.getByLabel('Value', { exact: true }).first().fill('710');
  await panel.getByRole('button', { name: 'Select', exact: true }).click();
  await expect(panel.locator('section', { hasText: 'Select where' }).getByRole('status')).toHaveText(
    '3 nodes selected.',
  );
  const group = panel.locator('section', { hasText: 'Group edit' });
  await group.getByLabel('Property').selectOption('elevation');
  await group.getByLabel('Action').selectOption('add');
  await group.getByLabel('Value').fill('5');
  await group.getByRole('button', { name: 'Apply' }).click();
  await expect(group.getByRole('status')).toHaveText('Changed elevation of 3 elements.');
  expect(await ws(page, (w) => w.state.store.doc.num(w.state.store.doc.findNode('10')!, 'elevation'))).toBe(
    715,
  );
  await ws(page, (w) => w.state.store.undo());
  expect(await ws(page, (w) => w.state.store.doc.num(w.state.store.doc.findNode('10')!, 'elevation'))).toBe(
    710,
  );
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  const results = page.locator('.panel.results');
  await results.getByLabel('Show where').selectOption({ label: 'Pressure' });
  await results.getByLabel('Relation').selectOption('above');
  await results.getByLabel('Filter value').fill('125');
  await results.getByRole('button', { name: 'Filter' }).click();
  await expect(results.getByRole('status')).toHaveText('1 of 11 nodes');
  await expect(results.locator('.grid-body .grid-row')).toHaveCount(1);
  await results.getByRole('button', { name: 'Show all' }).click();
  await results.getByRole('button', { name: /^Sort by Pressure/ }).click();
  await results.getByRole('button', { name: /^Sort by Pressure/ }).click();
  await expect(results.locator('.grid-body .grid-row').first()).toContainText('10');
});

test('labels the map: IDs, values, flow arrows and map labels', async ({ page }) => {
  await ready(page);
  const painted = () =>
    page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('.map-annotations')!;
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    });
  await expect.poll(painted).toBeGreaterThan(0); // Net1's own labels
  const base = await painted();
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Show node IDs' }).click();
  await expect.poll(painted).toBeGreaterThan(base);
  const withIds = await painted();
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  await page.getByRole('button', { name: 'Show flow arrows' }).click();
  await expect.poll(painted).toBeGreaterThan(withIds);
  // The label tool adds a label where you click, and edits or deletes one you click on.
  const box = (await page.locator('.map-overlay').boundingBox())!;
  const at = { x: box.x + 40, y: box.y + 40 };
  await page.locator('.map-overlay').focus();
  await page.keyboard.press('b');
  page.once('dialog', (d) => void d.accept('Pressure zone A'));
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() =>
      ws(page, (w) =>
        (w.state.store.doc.data as unknown as { labels: { text: string }[] }).labels.map((l) => l.text),
      ),
    )
    .toContain('Pressure zone A');
  page.once('dialog', (d) => {
    expect(d.defaultValue()).toBe('Pressure zone A');
    void d.accept('');
  });
  await page.mouse.click(at.x + 5, at.y + 6);
  await expect
    .poll(() =>
      ws(page, (w) =>
        (w.state.store.doc.data as unknown as { labels: { text: string }[] }).labels.map((l) => l.text),
      ),
    )
    .not.toContain('Pressure zone A');
});

test('works without a pointer: lists, adding elements, panning the map', async ({ page }) => {
  await ready(page);
  const list = page.getByRole('listbox', { name: 'junction list' });
  await list.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.panel.properties .panel-title')).toHaveText('Junction 11');
  await expect(list.getByRole('option', { selected: true })).toHaveText('11');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Show add element' }).click();
  const add = page.locator('.panel.add-element');
  await add.getByLabel('ID (optional)').fill('K1');
  await add.getByLabel('X', { exact: true }).fill('5');
  await add.getByLabel('Y', { exact: true }).fill('75');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByRole('status')).toHaveText('Added junction K1.');
  await add.getByLabel('Type').selectOption('pipe');
  await add.getByLabel('Start node').fill('K1');
  await add.getByLabel('End node').fill('10');
  await add.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(add.getByRole('status')).toContainText('Added pipe');
  await expect(page.locator('.statusbar')).toContainText('12 nodes · 14 links');
  const before = await nodeOnScreen(page, '10');
  await page.locator('.map-overlay').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await nodeOnScreen(page, '10')).x - before.x).toBeCloseTo(80, 0);
  // Single-key shortcuts can be turned off (WCAG 2.1.4).
  await page.keyboard.press('j');
  expect(await ws(page, (w) => (w.state as unknown as { tool: string }).tool)).toBe('junction');
  await page.keyboard.press('v');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Single-key shortcuts' }).click();
  await page.locator('.map-overlay').focus();
  await page.keyboard.press('j');
  expect(await ws(page, (w) => (w.state as unknown as { tool: string }).tool)).toBe('select');
});

test('edits link vertices, reverses links, and keeps lengths with auto-length', async ({ page }) => {
  await ready(page);
  const link = (field: string) =>
    page.evaluate((f) => {
      const w = (globalThis as unknown as { waterstudio: WS }).waterstudio;
      const d = w.state.store.doc as unknown as {
        findLink(id: string): number;
        get(h: number, f: string): unknown;
      };
      return d.get(d.findLink('11'), f);
    }, field);
  await ws(page, (w) => {
    const d = w.state.store.doc as unknown as { findLink(id: string): number };
    w.state.selection.clear();
    w.state.selection.add(d.findLink('11'));
    (w.state as unknown as { emit(): void }).emit();
  });
  await page.getByRole('button', { name: 'Auto-length off' }).click();
  const a = await nodeOnScreen(page, '11');
  const b = await nodeOnScreen(page, '12');
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  await page.mouse.dblclick(mid.x, mid.y);
  await expect.poll(() => link('vertices').then((v) => (v as number[]).length)).toBe(2);
  // Pipe 11 runs from (30, 70) to (50, 70): straight, its plan length is 20.
  expect(await link('length')).toBe(20);
  await page.mouse.move(mid.x, mid.y);
  await page.mouse.down();
  await page.mouse.move(mid.x, mid.y + 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => link('length').then((l) => l as number)).toBeGreaterThan(20);
  const bent = (await link('vertices')) as number[];
  expect(bent[1]).toBeLessThan(70);
  await page.mouse.dblclick(mid.x, mid.y + 40);
  await expect.poll(() => link('vertices').then((v) => (v as number[]).length)).toBe(0);
  expect(await link('length')).toBe(20);
  // Vertices can also be typed in the inspector.
  const typed = page.locator('.panel.properties').getByLabel('Vertices');
  await typed.fill('40 60');
  await typed.blur();
  await expect.poll(() => link('vertices')).toEqual([40, 60]);
  const from = await link('from');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Reverse link direction' }).click();
  expect(await link('to')).toBe(from);
});

test('exports the map as SVG and PNG and copies tables', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  const svgDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export map as SVG' }).click();
  const svgFile = await svgDownload;
  expect(svgFile.suggestedFilename()).toBe('Net1.svg');
  const svg = await readFile(await svgFile.path(), 'utf8');
  expect(svg).toMatch(/^<svg xmlns/);
  expect(svg.match(/<polyline/g)).toHaveLength(13);
  expect(svg).toContain('Node pressure');
  const pngDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export map as PNG' }).click();
  const png = await readFile(await (await pngDownload).path());
  expect([...png.subarray(1, 4)].map((c) => String.fromCharCode(c)).join('')).toBe('PNG');
  await page.locator('.panel.results').getByRole('button', { name: 'Copy' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^ID\tDemand \(gpm\)\tHead \(ft\)/);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text.split('\n')).toHaveLength(12);
});

test('exports a scenario and applies an edited one', async ({ page }) => {
  await ready(page);
  const out = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export scenario' }).click();
  const file = await out;
  expect(file.suggestedFilename()).toBe('Net1.scn');
  const text = await readFile(await file.path(), 'utf8');
  expect(text).toContain('[DIAMETERS]');
  // Net1's pipe 10 is 18 in; the edited scenario makes it 24 in.
  expect(text).toMatch(/^10\t18$/m);
  const edited = text.replace(/^10\t18$/m, '10\t24');
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import scenario' }).click();
  await (await chooser).setFiles({ name: 'bigger.scn', mimeType: 'text/plain', buffer: Buffer.from(edited) });
  await expect
    .poll(() =>
      ws(page, (w) => {
        const d = w.state.store.doc as unknown as {
          findLink(id: string): number;
          num(h: number, f: string): number;
        };
        return d.num(d.findLink('10'), 'diameter');
      }),
    )
    .toBe(24);
});

test('sets legend intervals by hand, and copies properties between elements', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Show legend editor' }).click();
  const editor = page.locator('.legend-panel section').first();
  await expect(editor).toContainText('automatic');
  await editor.getByLabel('Upper limit of interval 1').fill('50');
  await editor.getByLabel('Upper limit of interval 1').press('Enter');
  await expect(editor).toContainText('set by hand');
  await expect(page.locator('.legends')).toContainText('< 50');
  await editor.getByRole('button', { name: 'Automatic' }).click();
  await expect(page.locator('.legends')).not.toContainText('< 50');
  // Copy junction 10's properties onto junction 12.
  const list = page.getByRole('listbox', { name: 'junction list' });
  await list.focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+c');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+v');
  const twelve = () =>
    ws(page, (w) => {
      const d = w.state.store.doc;
      const h = d.findNode('12')!;
      return [d.num(h, 'elevation'), (d.get(h, 'demands') as { base: number }[])[0]!.base];
    });
  await expect.poll(twelve).toEqual([710, 0]);
});

test('formats numbers and shows an overview map', async ({ page }) => {
  await ready(page);
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  const first = page.locator('.panel.results .grid-body .grid-row').first();
  await expect(first).toContainText('127.54');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Show number formats' }).click();
  await page.locator('.panel.formats').getByLabel('Pressure').fill('0');
  await page.locator('.panel.formats').getByLabel('Pressure').press('Enter');
  await expect(first).toContainText('128');
  await expect(first).not.toContainText('127.54');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'View' }).click();
  await page.getByRole('button', { name: 'Show overview map' }).click();
  const overview = page.getByRole('img', { name: /Overview of the whole network/ });
  await expect(overview).toBeVisible();
  const before = await nodeOnScreen(page, '10');
  const ob = (await overview.boundingBox())!;
  await page.mouse.click(ob.x + 10, ob.y + 10);
  await expect.poll(async () => (await nodeOnScreen(page, '10')).x).not.toBeCloseTo(before.x, 0);
});

test('manages scenarios and compares two of them', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Show scenarios' }).click();
  const panel = page.locator('.panel.scenarios');
  page.once('dialog', (d) => void d.accept('Bigger mains'));
  await panel.getByRole('button', { name: 'New' }).click();
  await panel.getByRole('button', { name: 'Show and edit' }).click();
  await expect(page.locator('.statusbar')).toContainText('Scenario: Bigger mains');
  const diameter = () =>
    ws(page, (w) => {
      const d = w.state.store.doc as unknown as {
        findLink(id: string): number;
        num(h: number, f: string): number;
      };
      return d.num(d.findLink('10'), 'diameter');
    });
  await ws(page, (w) => {
    const d = w.state.store.doc as unknown as { findLink(id: string): number };
    w.state.selection.clear();
    w.state.selection.add(d.findLink('10'));
    (w.state as unknown as { emit(): void }).emit();
  });
  await page.locator('.panel.properties').getByLabel('Diameter').fill('24');
  await page.locator('.panel.properties').getByLabel('Diameter').press('Enter');
  expect(await diameter()).toBe(24);
  await expect(
    panel.getByRole('listbox', { name: 'Scenarios' }).getByRole('option', { name: /Bigger mains/ }),
  ).toContainText('1 changes');
  await panel.getByLabel('Result').selectOption('link:velocity');
  await panel.getByRole('button', { name: 'Run both and compare' }).click();
  await expect(panel.getByRole('status')).toContainText('links differ');
  await expect(panel.locator('.compare-top tbody tr').first()).toContainText('10');
  await panel
    .getByRole('listbox', { name: 'Scenarios' })
    .getByRole('option', { name: /Base network/ })
    .click();
  await panel.getByRole('button', { name: 'Show and edit' }).click();
  expect(await diameter()).toBe(18);
  await expect(page.locator('.statusbar')).toContainText('Base network');
});

test('runs fire flow and criticality studies across the engine pool', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Analysis' }).click();
  await page.getByRole('button', { name: 'Show studies' }).click();
  const panel = page.locator('.panel.studies');
  await panel.getByRole('button', { name: 'Test 9 hydrants' }).click();
  await expect(panel.getByRole('status')).toContainText('9 hydrants tested');
  await expect(panel.locator('.studies-table tbody tr')).toHaveCount(9);
  await panel.getByRole('tab', { name: 'Criticality' }).click();
  await panel.getByRole('button', { name: 'Take out 12 links in turn' }).click();
  await expect(panel.getByRole('status')).toContainText('12 links tested');
  await expect(panel.locator('.studies-table tbody tr')).toHaveCount(12);
  await panel.getByRole('button', { name: /Select critical links/ }).click();
  // Segments: valves by the N−1 rule, then one more with the tool.
  await panel.getByRole('tab', { name: 'Segments' }).click();
  await expect(panel).toContainText('0 isolation valves make 1 segments');
  await panel.getByRole('button', { name: 'N−1 rule' }).click();
  await expect(panel).toContainText(/\d+ isolation valves make \d+ segments/);
  const valves = () =>
    ws(
      page,
      (w) => (w.state.store.doc.data as unknown as { isolationValves: unknown[] }).isolationValves.length,
    );
  const before = await valves();
  await panel.getByRole('button', { name: 'Isolate' }).first().click();
  await expect(panel.getByRole('status')).toContainText('isolates segment');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Add or remove an isolation valve' }).click();
  const a = await nodeOnScreen(page, '21');
  const b = await nodeOnScreen(page, '22');
  await page.mouse.click(a.x + (b.x - a.x) * 0.2, a.y + (b.y - a.y) * 0.2);
  await expect.poll(valves).not.toBe(before);
  const axe = await new AxeBuilder({ page })
    .include('.panel.studies')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test('runs a multi-species analysis and shows its species as results', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Analysis' }).click();
  await page.getByRole('button', { name: 'Show multi-species' }).click();
  const panel = page.locator('.panel.msx-panel');
  await panel.getByRole('button', { name: 'Start from a template' }).click();
  const editor = panel.getByLabel('EPANET-MSX input');
  await expect(editor).toHaveValue(/\[SPECIES\]/);
  // An input error names its line, and the line is one click (or Enter) away.
  await editor.fill('[SPECIES]\nBULK CL2 MG\n[PIPES]\nRATE CL2 -k*CL2\n');
  await panel.getByRole('button', { name: 'Run MSX' }).click();
  await expect(panel.getByRole('alert')).toContainText('Error 409 (illegal math expression) at line 4');
  await panel.getByRole('button', { name: /at line 4/ }).click();
  await expect(editor).toBeFocused();
  expect(
    await editor.evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd)),
  ).toBe('RATE CL2 -k*CL2');
  await editor.fill(
    '[SPECIES]\nBULK CL2 MG\nWALL BIO UG\n[PIPES]\nRATE CL2 -0.5*CL2\nRATE BIO 0.01*CL2\n' +
      '[TANKS]\nRATE CL2 -0.5*CL2\n[QUALITY]\nGLOBAL CL2 1.0\n[REPORT]\nNODES 10 22\nSPECIES CL2 YES\n',
  );
  await editor.press('Control+Enter');
  await expect(panel.getByRole('tab', { name: 'Species (2)' })).toBeVisible({ timeout: 30_000 });
  await panel.getByRole('tab', { name: 'Species (2)' }).click();
  await panel.getByRole('row', { name: /CL2/ }).getByRole('button', { name: 'Nodes' }).click();
  await expect(page.locator('.legends')).toContainText('Node CL2');
  // Species are results like any other: the map theme, the results table, the report.
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await expect(page.getByLabel('Nodes').locator('option[value="msx:CL2"]')).toHaveCount(1);
  await expect(page.getByLabel('Links').locator('option[value="msx:BIO"]')).toHaveCount(1);
  await expect(page.getByLabel('Nodes').locator('option[value="msx:BIO"]')).toHaveCount(0);
  await panel.getByRole('tab', { name: 'Report' }).click();
  await expect(panel.getByLabel('MSX report')).toContainText('<<< Node 22 >>>');
  const axe = await new AxeBuilder({ page })
    .include('.panel.msx-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test('sets elevations from a DEM and allocates demands', async ({ page }) => {
  await ready(page);
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Elevations from a DEM or terrain…' }).click();
  const panel = page.locator('.panel.tools-panel');
  // A 10 × 10 grid over Net1 whose height grows by 1 per 10 units east: 100 + (x - 5) / 10.
  const rows = Array.from({ length: 10 }, () => Array.from({ length: 10 }, (_, i) => 100 + i).join(' '));
  const chooser = page.waitForEvent('filechooser');
  await panel.getByRole('button', { name: 'Choose DEM…' }).click();
  await (
    await chooser
  ).setFiles({
    name: 'ground.asc',
    mimeType: 'text/plain',
    buffer: Buffer.from(`ncols 10\nnrows 10\nxllcorner 0\nyllcorner 0\ncellsize 10\n${rows.join('\n')}\n`),
  });
  await expect(panel.getByText('ground.asc: 10 × 10 cells')).toBeVisible();
  await panel.getByLabel('The DEM’s heights are in feet').check();
  await panel.getByRole('button', { name: 'Set elevations' }).click();
  await expect(panel.locator('p[role=status]')).toContainText(
    'Set the elevations of 10 nodes from ground.asc',
  );
  const elevation = await ws(page, (w) =>
    w.state.store.doc.num(w.state.store.doc.findNode('10')!, 'elevation'),
  );
  expect(elevation).toBe(101.5); // at x = 20
  // Demands: 90 gpm spread equally over the nine junctions, into a new category.
  await panel.getByRole('tab', { name: 'Demand allocation' }).click();
  await panel.getByLabel('Total demand (gpm)').fill('90');
  await panel.getByRole('combobox', { name: 'Spread' }).selectOption('equal');
  await panel.getByLabel('Demand category (blank for the first)').fill('Growth');
  await panel.getByRole('button', { name: 'Allocate demands' }).click();
  await expect(panel.locator('p[role=status]')).toContainText('Allocated 90 gpm over 9 junctions equally');
  const growth = await ws(page, (w) => {
    const d = w.state.store.doc;
    return (d.get(d.findNode('12')!, 'demands') as { base: number; category: string | null }[]).find(
      (x) => x.category === 'Growth',
    )?.base;
  });
  expect(growth).toBe(10);
  const axe = await new AxeBuilder({ page })
    .include('.panel.tools-panel')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
});

test('the editors have no WCAG 2.2 AA violations', async ({ page }) => {
  await ready(page);
  await ws(page, (w) => {
    w.state.selection.add(w.state.store.doc.findNode('2')!);
    (w.state as unknown as { emit(): void }).emit();
  });
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  const audit = async (what: string) => {
    const r = await new AxeBuilder({ page })
      .exclude('.dv-tabs-container')
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(
      r.violations.map((v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
    ).toEqual([]);
  };
  await audit('inspector');
  await page.getByRole('button', { name: 'Show options' }).click();
  for (const tab of [
    'Hydraulics',
    'Demands',
    'Quality',
    'Times',
    'Energy',
    'Report',
    'Defaults',
    'Summary',
  ]) {
    await page.locator('.panel.options').getByRole('tab', { name: tab }).click();
    await audit(`options ${tab}`);
  }
  await page.getByRole('button', { name: 'Show patterns' }).click();
  await expect(page.locator('.panel.data-editor figure')).toBeVisible();
  await audit('patterns');
  await page.getByRole('button', { name: 'Show curves' }).click();
  await audit('curves');
  await page.getByRole('button', { name: 'Show controls' }).click();
  await audit('controls');
  await page.keyboard.press('Control+f');
  await audit('query');
  await page.keyboard.press('F5');
  await expect(page.getByTestId('run-status')).toContainText('Solved');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Results' }).click();
  await page.getByRole('button', { name: 'Show legend editor' }).click();
  await audit('legend');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Project' }).click();
  await page.getByRole('button', { name: 'Show scenarios' }).click();
  await audit('scenarios');
  await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Draw' }).click();
  await page.getByRole('button', { name: 'Show add element' }).click();
  await audit('add element');
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
    await page.getByRole('button', { name: 'Contour' }).click();
    await expect(page.locator('.panel.graph figure.contour')).toBeVisible();
    await page.getByRole('button', { name: 'Reports' }).click();
    await expect(page.locator('.panel.report .report-text')).toBeVisible();
    await page.getByRole('tablist', { name: 'Ribbon' }).getByRole('tab', { name: 'Analysis' }).click();
    await page.getByRole('button', { name: 'Show assistant' }).click();
    await expect(page.locator('.panel.assistant')).toBeVisible();
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

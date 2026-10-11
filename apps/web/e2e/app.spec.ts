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
  const bytes = await readFile((await zip.path()));
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
  await panel.getByRole('tab', { name: 'Title' }).click();
  await expect(panel.getByLabel('Title and notes')).toHaveValue(/EPANET Example Network 1/);
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
  for (const tab of ['Hydraulics', 'Demands', 'Quality', 'Times', 'Energy', 'Report', 'Title']) {
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

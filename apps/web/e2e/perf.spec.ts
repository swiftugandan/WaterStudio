/**
 * Performance budgets (PLAN.md, "Quality, performance and security"); a miss fails the
 * build. CI has no GPU, so drawing is measured on the backend the browser gives us there
 * (Canvas 2D) against its budget. Every measurement is also printed as `[perf]`.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

interface Bench {
  state: {
    openModel(m: unknown, name: string): void;
    store: {
      doc: { links: { liveCount: number }; nodes: { liveCount: number }; nodeHandles(): Iterable<number> };
      transact(label: string, fn: (tx: { set(h: number, f: string, v: unknown): void }) => void): void;
    };
    renderer: { backend: string | null };
    run: { status: string; results?: { times: number[] } };
    runHydraulics(): Promise<void>;
    setPeriod(p: number): void;
    engine: { run(m: unknown): Promise<{ value: { times: number[] }; ms: number }> };
    view: {
      fit(): void;
      zoom(f: number): void;
      panBy(dx: number, dy: number): void;
      frameStats(): { frames: number; ms: number; paints: number; paintMs: number };
    } | null;
  };
  gridModel(n: number): unknown;
  bench: {
    epsModel(n: number, hours?: number): unknown;
    networkModel(n: number, hours?: number): unknown;
    runFireFlow(m: unknown, o: unknown, progress: (d: number, t: number) => void): Promise<unknown[]>;
    studyPool(): { size: number };
  };
}

function report(line: string): void {
  test.info().annotations.push({ type: 'performance', description: line });
  console.log(`[perf] ${line}`);
}

async function start(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('renderer')).not.toHaveText('Starting renderer…');
  // The start-up sample must have loaded, or it would replace the network under test.
  await expect(page.locator('.statusbar')).toContainText('11 nodes · 13 links');
}

/** Open a bench network and wait for its first frame; returns the time that took. */
async function openGrid(page: Page, n: number, eps?: number): Promise<number> {
  return page.evaluate(
    async ([n, eps]) => {
      const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
      const m = eps === undefined ? w.gridModel(n) : w.bench.epsModel(n, eps);
      const before = w.state.view!.frameStats().frames;
      const t0 = performance.now();
      w.state.openModel(m, `grid-${n}.inp`);
      await new Promise<void>((done) => {
        const wait = () =>
          w.state.view!.frameStats().frames > before ? done() : requestAnimationFrame(wait);
        requestAnimationFrame(wait);
      });
      return performance.now() - t0;
    },
    [n, eps] as const,
  );
}

test('a 50,000-pipe network opens fast and pans within budget', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/${process.env['PERF_N'] ? `?n=${process.env['PERF_N']}` : ''}`);
  await expect(page.getByTestId('renderer')).not.toHaveText('Starting renderer…');
  // The start-up sample must have loaded, or it would replace the grid.
  await expect(page.locator('.statusbar')).toContainText('11 nodes · 13 links');
  const open = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    const t0 = performance.now();
    w.state.openModel(
      w.gridModel(Number(new URLSearchParams(location.search).get('n') ?? 159)),
      'grid-159.inp',
    );
    const opened = performance.now() - t0;
    await new Promise((r) => setTimeout(r, 50));
    return { opened, links: w.state.store.doc.links.liveCount };
  });
  if (!process.env['PERF_N']) expect(open.links).toBe(50_245);
  // Budget: open and draw a 10,000-pipe file in under 1.5 s; at five times the size, 7.5 s.
  expect(open.opened).toBeLessThan(7_500);

  const pan = (zoom: number) =>
    page.evaluate(async (z) => {
      const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
      const view = w.state.view!;
      view.fit();
      view.zoom(z);
      await new Promise((r) => setTimeout(r, 1500)); // first frame and scene upload
      const s0 = view.frameStats();
      const t0 = performance.now();
      let k = 0;
      await new Promise<void>((done) => {
        const step = () => {
          view.panBy(Math.sin(k++ / 10) * 12, 3);
          if (performance.now() - t0 < 3000) requestAnimationFrame(step);
          else done();
        };
        requestAnimationFrame(step);
      });
      const s1 = view.frameStats();
      const elapsed = (performance.now() - t0) / 1000;
      const frames = s1.frames - s0.frames;
      return {
        backend: w.state.renderer.backend,
        fps: frames / elapsed,
        msPerFrame: (s1.ms - s0.ms) / Math.max(1, frames),
      };
    }, zoom);
  // Whole network in view (junctions hidden by level of detail), then zoomed in with junctions drawn.
  for (const zoom of [1, 6]) {
    const result = await pan(zoom);
    const line = `${result.backend} at zoom ${zoom}: ${result.fps.toFixed(1)} fps panning 50,245 pipes, ${result.msPerFrame.toFixed(1)} ms per frame; opened in ${open.opened.toFixed(0)} ms`;
    test.info().annotations.push({ type: 'performance', description: line });
    console.log(`[perf] ${line}`);
    expect(result.fps).toBeGreaterThanOrEqual(result.backend === 'webgpu' ? 60 : 30);
  }
});

test('a 10,000-pipe network opens and draws in under 1.5 s', async ({ page }) => {
  await start(page);
  const ms = await openGrid(page, 71); // 5,041 junctions, 9,941 pipes
  report(`opened and drew 9,941 pipes in ${ms.toFixed(0)} ms`);
  expect(ms).toBeLessThan(1_500);
});

test('200,000 links pan at 30 fps or better on Canvas 2D', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  const opened = await openGrid(page, 317); // 100,489 junctions, 200,345 pipes
  const result = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    const view = w.state.view!;
    view.fit();
    await new Promise((r) => setTimeout(r, 2000));
    const s0 = view.frameStats();
    const t0 = performance.now();
    let k = 0;
    await new Promise<void>((done) => {
      const step = () => {
        view.panBy(Math.sin(k++ / 10) * 12, 3);
        if (performance.now() - t0 < 3000) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    const s1 = view.frameStats();
    return {
      backend: w.state.renderer.backend,
      fps: (s1.frames - s0.frames) / ((performance.now() - t0) / 1000),
    };
  });
  report(
    `${result.backend}: ${result.fps.toFixed(1)} fps panning 200,345 pipes; opened in ${opened.toFixed(0)} ms`,
  );
  expect(result.fps).toBeGreaterThanOrEqual(result.backend === 'webgpu' ? 60 : 30);
});

// The engine budgets use a network as sparse as real ones (about 1.25 pipes per junction;
// a utility model in our corpus has 1.16). A full grid, with two, is reported too: it is
// the worst case for the sparse solver.
test('a 24-hour simulation of 10,000 nodes takes under 2 s in one worker', async ({ page }) => {
  test.setTimeout(120_000);
  await start(page);
  const grid = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    await w.state.engine.run(w.gridModel(3));
    const t0 = performance.now();
    await w.state.engine.run(w.bench.epsModel(100, 24));
    return performance.now() - t0;
  });
  report(`24-hour EPS of a full 100 × 100 grid (19,801 pipes): ${grid.toFixed(0)} ms`);
  const r = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    const m = w.bench.networkModel(100, 24); // 10,000 junctions, about 12,500 pipes, hourly steps
    await w.state.engine.run(w.gridModel(3)); // the engine worker is warm
    const t0 = performance.now();
    const { value, ms } = await w.state.engine.run(m);
    return { wall: performance.now() - t0, engine: ms, periods: value.times.length };
  });
  report(
    `24-hour EPS of 10,000 nodes: ${r.wall.toFixed(0)} ms (${r.engine.toFixed(0)} ms in the engine), ${r.periods} periods`,
  );
  expect(r.periods).toBe(25);
  expect(r.wall).toBeLessThan(2_000);
});

test('a time step of 100,000 elements repaints in under 16 ms', async ({ page }) => {
  test.setTimeout(180_000);
  await start(page);
  await openGrid(page, 183, 6); // 33,489 junctions and 66,613 pipes
  const r = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    await w.state.runHydraulics();
    const view = w.state.view!;
    const frame = (n: number) =>
      new Promise<void>((done) => {
        const wait = () => (view.frameStats().frames >= n ? done() : requestAnimationFrame(wait));
        requestAnimationFrame(wait);
      });
    await new Promise((r) => setTimeout(r, 500));
    const steps: number[] = [];
    const parts: string[] = [];
    for (let p = 1; p <= 6; p++) {
      const s0 = view.frameStats();
      w.state.setPeriod(p);
      await frame(s0.frames + 1);
      const s1 = view.frameStats();
      const paint = s1.paintMs - s0.paintMs;
      const draw = (s1.ms - s0.ms) / Math.max(1, s1.frames - s0.frames);
      steps.push(paint + draw);
      parts.push(`${paint.toFixed(1)}+${draw.toFixed(1)}`);
    }
    return {
      status: w.state.run.status,
      worst: Math.max(...steps),
      mean: steps.reduce((a, b) => a + b) / steps.length,
      parts: parts.join(' '),
    };
  });
  report(
    `time step of 100,102 elements: ${r.mean.toFixed(1)} ms on average, ${r.worst.toFixed(1)} ms at worst (paint+draw: ${r.parts})`,
  );
  expect(r.status).toBe('done');
  expect(r.worst).toBeLessThan(16);
});

test('an edit repaints in under 50 ms without a long task', async ({ page }) => {
  await start(page);
  await openGrid(page, 71);
  const r = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    const view = w.state.view!;
    await new Promise((r) => setTimeout(r, 500));
    const long: number[] = [];
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) long.push(e.duration);
    });
    obs.observe({ type: 'longtask', buffered: false });
    const handles = [...w.state.store.doc.nodeHandles()].slice(1, 11);
    const times: number[] = [];
    for (const h of handles) {
      const before = view.frameStats().frames;
      const t0 = performance.now();
      w.state.store.transact('Move', (tx) => tx.set(h, 'x', 50));
      await new Promise<void>((done) => {
        const wait = () => (view.frameStats().frames > before ? done() : requestAnimationFrame(wait));
        requestAnimationFrame(wait);
      });
      times.push(performance.now() - t0);
    }
    await new Promise((r) => setTimeout(r, 100));
    obs.disconnect();
    return { worst: Math.max(...times), long };
  });
  report(
    `edit to repaint on 9,941 pipes: ${r.worst.toFixed(1)} ms at worst; long tasks: ${r.long.map((d) => d.toFixed(0)).join(', ') || 'none'}`,
  );
  expect(r.worst).toBeLessThan(50);
  expect(r.long).toEqual([]);
});

test('fire flow at 1,000 hydrants of a 10,000-node network takes under 10 s on 8 workers', async ({
  page,
}) => {
  test.setTimeout(180_000);
  await start(page);
  const r = await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    const m = w.bench.networkModel(100, 0) as { nodes: { id: string }[] };
    const hydrants = m.nodes
      .filter((n) => n.id !== 'R')
      .map((n) => n.id)
      .filter((_, i) => i % 10 === 0);
    const pool = w.bench.studyPool();
    const t0 = performance.now();
    const results = await w.bench.runFireFlow(m, { hydrants, flow: 500, residual: 20 }, () => {});
    return { ms: performance.now() - t0, workers: pool.size, n: results.length };
  });
  // Scaled to the workers this machine runs (the budget is for eight).
  const budget = 10_000 * (8 / Math.min(8, r.workers));
  report(
    `fire flow at ${r.n} hydrants of 10,000 nodes: ${r.ms.toFixed(0)} ms on ${r.workers} workers (budget ${budget.toFixed(0)} ms)`,
  );
  expect(r.n).toBe(1_000);
  expect(r.ms).toBeLessThan(budget);
});

test('a 100,000-element network with a simulation loaded stays under 1 GB', async ({ page, browser }) => {
  test.skip(process.platform !== 'linux', 'reads process memory from /proc');
  test.setTimeout(180_000);
  await start(page);
  await openGrid(page, 183, 24);
  await page.evaluate(async () => {
    const w = (globalThis as unknown as { waterstudio: Bench }).waterstudio;
    await w.state.runHydraulics();
  });
  const cdp = await browser.newBrowserCDPSession();
  const { processInfo } = (await cdp.send('SystemInfo.getProcessInfo')) as {
    processInfo: { type: string; id: number }[];
  };
  // The tab's renderer process holds the page, its engine and rendering workers.
  const rss = processInfo
    .filter((p) => p.type === 'renderer')
    .map((p) => {
      const m = /VmRSS:\s+(\d+) kB/.exec(readFileSync(`/proc/${p.id}/status`, 'utf8'));
      return m ? Number(m[1]) * 1024 : 0;
    });
  const mb = Math.max(...rss) / 2 ** 20;
  report(`100,102 elements with a 24-hour simulation: ${mb.toFixed(0)} MB resident in the tab`);
  expect(mb).toBeLessThan(1024);
});

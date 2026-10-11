/**
 * Performance budgets (PLAN.md, "Quality, performance and security"). The Phase 1 gate:
 * a 50,000-pipe network pans within budget. CI has no GPU, so this measures the backend
 * the browser gives us there (Canvas 2D) against its budget of 30 frames per second.
 */

import { expect, test } from '@playwright/test';

interface Bench {
  state: {
    openModel(m: unknown, name: string): void;
    store: { doc: { links: { liveCount: number } } };
    renderer: { backend: string | null };
    view: {
      fit(): void;
      zoom(f: number): void;
      panBy(dx: number, dy: number): void;
      frameStats(): { frames: number; ms: number };
    } | null;
  };
  gridModel(n: number): unknown;
}

test('a 50,000-pipe network opens fast and pans within budget', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(`/${process.env['PERF_N'] ? `?n=${process.env['PERF_N']}` : ''}`);
  await expect(page.getByTestId('renderer')).not.toHaveText('Starting renderer…');
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

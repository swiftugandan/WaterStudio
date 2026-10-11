import { describe, expect, it } from 'vitest';
import { contours, edgeLimit, triangulate } from './contour.ts';

/** Total area of the rings in an SVG path of M…L…Z rings. */
function area(path: string): number {
  let total = 0;
  for (const ring of path.split('Z').filter(Boolean)) {
    const p = ring
      .slice(1)
      .split('L')
      .map((s) => s.split(',').map(Number) as [number, number]);
    let a = 0;
    for (let i = 0; i < p.length; i++) {
      const [x1, y1] = p[i]!;
      const [x2, y2] = p[(i + 1) % p.length]!;
      a += x1 * y2 - x2 * y1;
    }
    total += Math.abs(a) / 2;
  }
  return total;
}

describe('contours', () => {
  const xs = [0, 1, 1, 0];
  const ys = [0, 0, 1, 1];
  const v = [0, 10, 20, 10]; // v = 10x + 10y

  it('splits the triangulated area into bands that cover it exactly', () => {
    const tri = triangulate(xs, ys);
    expect(tri.length).toBe(6);
    const c = contours(xs, ys, v, tri, [5, 15]);
    expect(c.triangles).toBe(2);
    const areas = c.bands.map(area);
    // v < 5 is the corner triangle x + y < 0.5, area 1/8; v >= 15 likewise.
    expect(areas[0]).toBeCloseTo(0.125, 6);
    expect(areas[2]).toBeCloseTo(0.125, 6);
    expect(areas[0]! + areas[1]! + areas[2]!).toBeCloseTo(1, 6);
    expect(c.lines[0]).toMatch(/^M/);
  });

  it('leaves out long triangles and missing values', () => {
    const tri = triangulate([0, 1, 0, 100], [0, 0, 1, 100], 2);
    expect(tri.length).toBe(3);
    const c = contours(xs, ys, [0, NaN, 20, 10], triangulate(xs, ys), [5]);
    expect(c.triangles).toBe(1);
    expect(edgeLimit([1, 2, 3, 0, NaN])).toBe(9);
  });
});

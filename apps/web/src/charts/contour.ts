/**
 * Contours of a node variable over the network, as EPANET's contour plot draws them:
 * the nodes are triangulated (Delaunay), values vary linearly across each triangle, and
 * each triangle is clipped into the legend's bands; contour lines are where a triangle
 * crosses a break. Triangles much longer than the network's links (across a lake or
 * outside the network's outline) are left out rather than extrapolated over.
 */

import Delaunator from 'delaunator';

export interface Contours {
  /** One SVG path per band (breaks.length + 1), in the input coordinates. */
  bands: string[];
  /** One SVG path per break. */
  lines: string[];
  triangles: number;
}

/** Triangles of the points as vertex index triples, without the over-long ones. */
export function triangulate(xs: ArrayLike<number>, ys: ArrayLike<number>, maxEdge = Infinity): Uint32Array {
  const n = xs.length;
  if (n < 3) return new Uint32Array(0);
  const coords = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    coords[2 * i] = xs[i]!;
    coords[2 * i + 1] = ys[i]!;
  }
  const t = new Delaunator(coords).triangles;
  if (!Number.isFinite(maxEdge)) return t;
  const keep: number[] = [];
  const m2 = maxEdge * maxEdge;
  const d2 = (a: number, b: number) => (xs[a]! - xs[b]!) ** 2 + (ys[a]! - ys[b]!) ** 2;
  for (let k = 0; k < t.length; k += 3) {
    const a = t[k]!;
    const b = t[k + 1]!;
    const c = t[k + 2]!;
    if (d2(a, b) <= m2 && d2(b, c) <= m2 && d2(c, a) <= m2) keep.push(a, b, c);
  }
  return Uint32Array.from(keep);
}

type P = [number, number, number];

/** Sutherland-Hodgman against v >= lo (sign 1) or v <= hi (sign -1), interpolating linearly. */
function clip(poly: P[], level: number, sign: 1 | -1): P[] {
  const out: P[] = [];
  const inside = (p: P) => sign * (p[2] - level) >= 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (level - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), level]);
    }
  }
  return out;
}

const r = (v: number) => Number(v.toFixed(3));

function ring(poly: P[], sx: (x: number) => number, sy: (y: number) => number): string {
  return `M${poly.map((p) => `${r(sx(p[0]))},${r(sy(p[1]))}`).join('L')}Z`;
}

/**
 * Band and line paths. `sx`/`sy` map input coordinates to the drawing's. Vertices with
 * a non-finite value are skipped with their triangles.
 */
export function contours(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  values: ArrayLike<number>,
  tri: Uint32Array,
  breaks: readonly number[],
  sx: (x: number) => number = (x) => x,
  sy: (y: number) => number = (y) => y,
): Contours {
  const bands: string[][] = Array.from({ length: breaks.length + 1 }, () => []);
  const lines: string[][] = breaks.map(() => []);
  let count = 0;
  for (let k = 0; k < tri.length; k += 3) {
    const ids = [tri[k]!, tri[k + 1]!, tri[k + 2]!];
    const pts = ids.map((i) => [xs[i]!, ys[i]!, values[i]!] as P);
    if (pts.some((p) => !Number.isFinite(p[2]))) continue;
    count++;
    const vmin = Math.min(pts[0]![2], pts[1]![2], pts[2]![2]);
    const vmax = Math.max(pts[0]![2], pts[1]![2], pts[2]![2]);
    for (let b = 0; b <= breaks.length; b++) {
      const lo = b === 0 ? -Infinity : breaks[b - 1]!;
      const hi = b === breaks.length ? Infinity : breaks[b]!;
      if (vmax < lo || vmin >= hi) continue;
      let poly = pts;
      if (vmin < lo) poly = clip(poly, lo, 1);
      if (vmax > hi) poly = clip(poly, hi, -1);
      if (poly.length >= 3) bands[b]!.push(ring(poly, sx, sy));
    }
    for (let j = 0; j < breaks.length; j++) {
      const level = breaks[j]!;
      if (level < vmin || level > vmax || vmin === vmax) continue;
      const cross: [number, number][] = [];
      for (let e = 0; e < 3; e++) {
        const a = pts[e]!;
        const c = pts[(e + 1) % 3]!;
        if ((a[2] - level) * (c[2] - level) < 0 || (a[2] === level && c[2] !== level)) {
          const t = (level - a[2]) / (c[2] - a[2]);
          cross.push([a[0] + t * (c[0] - a[0]), a[1] + t * (c[1] - a[1])]);
        }
      }
      if (cross.length >= 2) {
        const [p, q] = cross as [[number, number], [number, number]];
        lines[j]!.push(`M${r(sx(p[0]))},${r(sy(p[1]))}L${r(sx(q[0]))},${r(sy(q[1]))}`);
      }
    }
  }
  return { bands: bands.map((b) => b.join('')), lines: lines.map((l) => l.join('')), triangles: count };
}

/** A length a few times the typical link, beyond which triangles are left out. */
export function edgeLimit(lengths: number[]): number {
  const v = lengths.filter((x) => x > 0 && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return Infinity;
  return 3 * v[Math.min(v.length - 1, Math.floor(0.95 * v.length))]!;
}

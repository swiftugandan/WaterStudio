/**
 * Demand allocation: spreading a total demand over junctions (equally or by the length
 * of pipe each serves), or assigning customer demands at points to the nearest
 * junction or pipe. The result is one undoable edit of a demand category.
 */

import type { Document, model, Store } from '@waterstudio/core';

/** A demand at a place, in the model's coordinates and flow units. */
export interface DemandPoint {
  x: number;
  y: number;
  demand: number;
}

export type TotalMethod = 'equal' | 'length';
export type PointMethod = 'node' | 'pipe';

/** Where allocated demand goes: a named category, or the first one when the name is empty. */
export interface DemandTarget {
  category: string;
  pattern: string | null;
  /** Add to what the category already holds instead of replacing it. */
  add: boolean;
}

export interface Allocation {
  /** Junction handle and the demand it receives. */
  demands: Map<number, number>;
  /** Points that found no junction (only for point methods). */
  unassigned: number;
}

function isJunction(doc: Document, h: number): boolean {
  return doc.kind(h) === 'junction';
}

/** Junctions among `scope` (or every junction). */
export function junctions(doc: Document, scope?: ReadonlySet<number>): number[] {
  return [...doc.nodeHandles()].filter((h) => isJunction(doc, h) && (!scope || scope.has(h)));
}

/**
 * Spread `total` over `targets`: equally, or in proportion to half the length of the
 * pipes connected to each junction (the length of main it serves).
 */
export function allocateTotal(
  doc: Document,
  targets: readonly number[],
  total: number,
  method: TotalMethod,
): Allocation {
  const demands = new Map<number, number>();
  if (targets.length === 0) return { demands, unassigned: 0 };
  if (method === 'equal') {
    for (const h of targets) demands.set(h, total / targets.length);
    return { demands, unassigned: 0 };
  }
  const half = new Map<number, number>(targets.map((h) => [h, 0]));
  for (const l of doc.linkHandles()) {
    if (doc.kind(l) !== 'pipe') continue;
    const len = doc.num(l, 'length');
    if (!Number.isFinite(len) || len <= 0) continue;
    for (const end of ['from', 'to'] as const) {
      const n = doc.get(l, end) as number;
      const v = half.get(n);
      if (v !== undefined) half.set(n, v + len / 2);
    }
  }
  const sum = [...half.values()].reduce((a, b) => a + b, 0);
  for (const [h, v] of half) demands.set(h, sum > 0 ? (total * v) / sum : total / targets.length);
  return { demands, unassigned: 0 };
}

/** A uniform grid of items for nearest-neighbour searches. */
class Grid<T> {
  private readonly cells = new Map<string, T[]>();
  constructor(private readonly size: number) {}
  private key(i: number, j: number): string {
    return `${i},${j}`;
  }
  add(minX: number, minY: number, maxX: number, maxY: number, item: T): void {
    for (let i = Math.floor(minX / this.size); i <= Math.floor(maxX / this.size); i++) {
      for (let j = Math.floor(minY / this.size); j <= Math.floor(maxY / this.size); j++) {
        const k = this.key(i, j);
        let c = this.cells.get(k);
        if (!c) this.cells.set(k, (c = []));
        c.push(item);
      }
    }
  }
  /** Items in rings of cells around (x, y), nearest rings first, until `done` says stop. */
  search(
    x: number,
    y: number,
    visit: (item: T) => void,
    done: (ringDistance: number) => boolean,
    maxRings: number,
  ): void {
    const ci = Math.floor(x / this.size);
    const cj = Math.floor(y / this.size);
    for (let r = 0; r <= maxRings; r++) {
      for (let i = ci - r; i <= ci + r; i++) {
        for (let j = cj - r; j <= cj + r; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== r) continue;
          for (const item of this.cells.get(this.key(i, j)) ?? []) visit(item);
        }
      }
      // Anything in ring r + 1 is at least r cells away.
      if (done(r * this.size)) return;
    }
  }
}

function extent(points: [number, number][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return Math.max(maxX - minX, maxY - minY, 1e-9);
}

/** The points of a link's polyline: start node, vertices, end node. */
function polyline(doc: Document, l: number): [number, number][] {
  const a = doc.get(l, 'from') as number;
  const b = doc.get(l, 'to') as number;
  const v = doc.get(l, 'vertices') as number[];
  const pts: [number, number][] = [[doc.num(a, 'x'), doc.num(a, 'y')]];
  for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i]!, v[i + 1]!]);
  pts.push([doc.num(b, 'x'), doc.num(b, 'y')]);
  return pts;
}

/**
 * Assign each point's demand to the nearest of `targets` (`node`), or to the nearest
 * pipe touching a target, split between its end junctions in proportion to how close
 * the point lies to each along the pipe (`pipe`). Points farther than `maxDistance`
 * (when given) stay unassigned.
 */
export function allocatePoints(
  doc: Document,
  targets: readonly number[],
  points: readonly DemandPoint[],
  method: PointMethod,
  maxDistance = Infinity,
): Allocation {
  const demands = new Map<number, number>();
  const add = (h: number, q: number) => demands.set(h, (demands.get(h) ?? 0) + q);
  const targetSet = new Set(targets);
  const coords: [number, number][] = targets
    .map((h): [number, number] => [doc.num(h, 'x'), doc.num(h, 'y')])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (coords.length === 0) return { demands, unassigned: points.length };
  const cell = Math.max(extent(coords) / Math.sqrt(coords.length), 1e-9);
  // Far enough to reach every target from any point (or the distance limit).
  const span = extent([...coords, ...points.map((p): [number, number] => [p.x, p.y])]);
  const maxRings = Math.ceil(Math.min(maxDistance, span) / cell) + 1;
  let unassigned = 0;

  if (method === 'node') {
    const grid = new Grid<number>(cell);
    for (const h of targets) {
      const x = doc.num(h, 'x');
      const y = doc.num(h, 'y');
      if (Number.isFinite(x) && Number.isFinite(y)) grid.add(x, y, x, y, h);
    }
    for (const p of points) {
      let best = -1;
      let bestD = Infinity;
      grid.search(
        p.x,
        p.y,
        (h) => {
          const d = Math.hypot(doc.num(h, 'x') - p.x, doc.num(h, 'y') - p.y);
          if (d < bestD) {
            bestD = d;
            best = h;
          }
        },
        (ring) => bestD <= ring,
        maxRings,
      );
      if (best < 0 || bestD > maxDistance) unassigned++;
      else add(best, p.demand);
    }
    return { demands, unassigned };
  }

  // Pipes with at least one target junction at an end, segment by segment.
  interface Seg {
    link: number;
    ax: number;
    ay: number;
    bx: number;
    by: number;
    /** Distance along the pipe at the segment's start, and the pipe's drawn length. */
    s0: number;
    total: number;
    from: number;
    to: number;
  }
  const grid = new Grid<Seg>(cell);
  for (const l of doc.linkHandles()) {
    if (doc.kind(l) !== 'pipe') continue;
    const from = doc.get(l, 'from') as number;
    const to = doc.get(l, 'to') as number;
    if (!targetSet.has(from) && !targetSet.has(to)) continue;
    const pts = polyline(doc, l);
    if (pts.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
    let total = 0;
    for (let i = 1; i < pts.length; i++)
      total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
    let s0 = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1]!;
      const [bx, by] = pts[i]!;
      grid.add(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), {
        link: l,
        ax,
        ay,
        bx,
        by,
        s0,
        total,
        from,
        to,
      });
      s0 += Math.hypot(bx - ax, by - ay);
    }
  }
  for (const p of points) {
    let best: Seg | null = null;
    let bestD = Infinity;
    let bestS = 0;
    grid.search(
      p.x,
      p.y,
      (s) => {
        const vx = s.bx - s.ax;
        const vy = s.by - s.ay;
        const len2 = vx * vx + vy * vy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.ax) * vx + (p.y - s.ay) * vy) / len2)) : 0;
        const d = Math.hypot(s.ax + t * vx - p.x, s.ay + t * vy - p.y);
        if (d < bestD) {
          bestD = d;
          best = s;
          bestS = s.s0 + t * Math.sqrt(len2);
        }
      },
      (ring) => bestD <= ring,
      maxRings,
    );
    const s = best as Seg | null;
    if (!s || bestD > maxDistance) {
      unassigned++;
      continue;
    }
    const f = s.total > 0 ? bestS / s.total : 0.5;
    const toFrom = targetSet.has(s.from);
    const toTo = targetSet.has(s.to);
    if (toFrom && toTo) {
      add(s.from, p.demand * (1 - f));
      add(s.to, p.demand * f);
    } else add(toFrom ? s.from : s.to, p.demand);
  }
  return { demands, unassigned };
}

/** A junction's demand categories with `q` written into the target category. */
export function withDemand(
  current: readonly model.Demand[],
  q: number,
  target: DemandTarget,
): model.Demand[] {
  const list = current.map((d) => ({ ...d }));
  const i = target.category ? list.findIndex((d) => d.category === target.category) : 0;
  const round = (v: number) => Math.round(v * 1e6) / 1e6;
  if (i >= 0 && i < list.length) {
    const d = list[i]!;
    d.base = round(target.add ? d.base + q : q);
    if (target.pattern !== null) d.pattern = target.pattern;
  } else {
    list.push({ base: round(q), pattern: target.pattern, category: target.category || null });
  }
  return list;
}

/** Write an allocation as one undoable edit; returns how many junctions changed. */
export function applyAllocation(
  store: Store,
  alloc: Allocation,
  target: DemandTarget,
  label: string,
): number {
  const doc = store.doc;
  const updates: [number, model.Demand[]][] = [];
  for (const [h, q] of alloc.demands) {
    if (!doc.has(h) || !isJunction(doc, h)) continue;
    updates.push([h, withDemand(doc.get(h, 'demands') as model.Demand[], q, target)]);
  }
  if (updates.length === 0) return 0;
  store.transact(label, (tx) => {
    for (const [h, d] of updates) tx.set(h, 'demands', d);
  });
  return updates.length;
}

/**
 * Read demand points from CSV or tab-separated text with a header row: the columns
 * named `x`, `y` and `demand` (or the names given), in any order.
 */
export function parseDemandPoints(
  text: string,
  columns: { x: string; y: string; demand: string } = { x: 'x', y: 'y', demand: 'demand' },
): { points: DemandPoint[]; issues: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#'));
  const points: DemandPoint[] = [];
  const issues: string[] = [];
  const first = lines[0];
  if (!first) return { points, issues: ['The file is empty.'] };
  const sep = first.includes('\t') ? '\t' : first.includes(';') && !first.includes(',') ? ';' : ',';
  const head = first.split(sep).map((h) => h.trim().replace(/^"|"$/g, '').toLowerCase());
  const col = (name: string) => head.indexOf(name.toLowerCase());
  const ix = col(columns.x);
  const iy = col(columns.y);
  const iq = col(columns.demand);
  const missing = (
    [
      [ix, columns.x],
      [iy, columns.y],
      [iq, columns.demand],
    ] as const
  )
    .filter(([i]) => i < 0)
    .map(([, n]) => n);
  if (missing.length)
    return { points, issues: [`No column named ${missing.join(', ')} in the header: ${head.join(', ')}.`] };
  lines.slice(1).forEach((line, k) => {
    const cells = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
    const x = Number(cells[ix]);
    const y = Number(cells[iy]);
    const demand = Number(cells[iq]);
    if ([x, y, demand].every(Number.isFinite)) points.push({ x, y, demand });
    else if (issues.length < 20) issues.push(`Line ${k + 2}: not three numbers.`);
  });
  return { points, issues };
}

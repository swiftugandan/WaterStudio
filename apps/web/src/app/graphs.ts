/**
 * EPANET's graphs as data: time series of chosen elements, a profile along a path of
 * nodes, the frequency distribution of a variable at one time, and the system's flow
 * balance over time. Pure functions of the document and a run's results.
 */

import type { Document } from '@waterstudio/core';
import {
  linkSeries,
  nodeFrame,
  linkFrame,
  nodeSeries,
  type LinkVar,
  type NodeVar,
  type RunResults,
} from '@waterstudio/engine-client';
import type { Series } from '../charts/LineChart.tsx';

export type GraphSpec =
  | { kind: 'series'; table: 'node'; variable: NodeVar; ids: string[] }
  | { kind: 'series'; table: 'link'; variable: LinkVar; ids: string[] }
  | { kind: 'profile'; variable: NodeVar; ids: string[] }
  | { kind: 'frequency'; table: 'node'; variable: NodeVar }
  | { kind: 'frequency'; table: 'link'; variable: LinkVar }
  | { kind: 'flow' }
  | { kind: 'contour'; variable: NodeVar };

export interface RunIndex {
  results: RunResults;
  /** Handles of the nodes and links in result column order. */
  nodes: Uint32Array;
  links: Uint32Array;
}

function columnOf(handles: Uint32Array, h: number): number {
  return handles.indexOf(h);
}

/** Report times in hours. */
export function hours(r: RunResults): number[] {
  return r.times.map((_, p) => (r.reportStart + p * r.reportStep) / 3600);
}

/** One series per element that exists and has results. */
export function timeSeries(
  doc: Document,
  run: RunIndex,
  spec: Extract<GraphSpec, { kind: 'series' }>,
): Series[] {
  const x = hours(run.results);
  const out: Series[] = [];
  for (const id of spec.ids) {
    const h = spec.table === 'node' ? doc.findNode(id) : doc.findLink(id);
    if (h === undefined) continue;
    const col = columnOf(spec.table === 'node' ? run.nodes : run.links, h);
    if (col < 0) continue;
    const y =
      spec.table === 'node'
        ? nodeSeries(run.results, spec.variable, col)
        : linkSeries(run.results, spec.variable, col);
    out.push({ name: `${doc.kind(h)[0]!.toUpperCase()}${doc.kind(h).slice(1)} ${id}`, x, y });
  }
  return out;
}

/**
 * The shortest path (by pipe length; pumps and valves count as zero) visiting the
 * given nodes in order, as node handles with the distance from the start of each.
 */
export function profilePath(doc: Document, ids: string[]): { nodes: number[]; distance: number[] } | null {
  const stops = ids.map((id) => doc.findNode(id)).filter((h): h is number => h !== undefined);
  if (stops.length < 2) return null;
  // Adjacency with lengths, built once.
  const adj = new Map<number, { to: number; len: number }[]>();
  const add = (a: number, b: number, len: number) => {
    let l = adj.get(a);
    if (!l) adj.set(a, (l = []));
    l.push({ to: b, len });
  };
  for (const l of doc.linkHandles()) {
    const a = doc.get(l, 'from') as number;
    const b = doc.get(l, 'to') as number;
    const len = doc.linkKind(l) === 'pipe' ? Math.max(0, doc.num(l, 'length') || 0) : 0;
    add(a, b, len);
    add(b, a, len);
  }
  const nodes: number[] = [stops[0]!];
  const distance: number[] = [0];
  for (let s = 1; s < stops.length; s++) {
    const leg = dijkstra(adj, stops[s - 1]!, stops[s]!);
    if (!leg) return null;
    const base = distance[distance.length - 1]!;
    for (let i = 1; i < leg.nodes.length; i++) {
      nodes.push(leg.nodes[i]!);
      distance.push(base + leg.distance[i]!);
    }
  }
  return { nodes, distance };
}

function dijkstra(
  adj: Map<number, { to: number; len: number }[]>,
  from: number,
  to: number,
): { nodes: number[]; distance: number[] } | null {
  const dist = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  // A binary heap of [distance, node].
  const heap: [number, number][] = [[0, from]];
  const push = (e: [number, number]) => {
    heap.push(e);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= heap[i]![0]) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0 && last) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  for (let e = pop(); e; e = pop()) {
    const [d, n] = e;
    if (d > (dist.get(n) ?? Infinity)) continue;
    if (n === to) break;
    for (const { to: m, len } of adj.get(n) ?? []) {
      const nd = d + len;
      if (nd < (dist.get(m) ?? Infinity)) {
        dist.set(m, nd);
        prev.set(m, n);
        push([nd, m]);
      }
    }
  }
  if (!dist.has(to)) return null;
  const nodes: number[] = [];
  for (let n: number | undefined = to; n !== undefined; n = n === from ? undefined : prev.get(n))
    nodes.push(n);
  nodes.reverse();
  return { nodes, distance: nodes.map((n) => dist.get(n)!) };
}

/** Values of a node variable along a path at one report period. */
export function profileSeries(
  doc: Document,
  run: RunIndex,
  spec: Extract<GraphSpec, { kind: 'profile' }>,
  period: number,
): { series: Series[]; labels: string[] } | null {
  const path = profilePath(doc, spec.ids);
  if (!path) return null;
  const frame = nodeFrame(run.results, spec.variable, period);
  const y = path.nodes.map((h) => {
    const c = columnOf(run.nodes, h);
    return c < 0 ? NaN : frame[c]!;
  });
  const series: Series[] = [{ name: spec.variable, x: path.distance, y }];
  if (spec.variable === 'head') {
    series.push({ name: 'elevation', x: path.distance, y: path.nodes.map((h) => elevationOf(doc, h)) });
  }
  return { series, labels: path.nodes.map((h) => doc.id(h)) };
}

function elevationOf(doc: Document, h: number): number {
  const k = doc.nodeKind(h);
  return k === 'reservoir' ? doc.num(h, 'head') : doc.num(h, 'elevation');
}

/**
 * The cumulative distribution of a variable at one period: for each value, the
 * percent of elements at or below it (EPANET's frequency plot). Flows use magnitudes.
 */
export function frequency(values: ArrayLike<number>, magnitude = false): { x: number[]; y: number[] } {
  const v = Array.from(values, (a) => (magnitude ? Math.abs(a) : a)).filter(Number.isFinite);
  v.sort((a, b) => a - b);
  const n = v.length;
  return { x: v, y: v.map((_, i) => ((i + 1) / n) * 100) };
}

export function frequencySeries(
  run: RunIndex,
  spec: Extract<GraphSpec, { kind: 'frequency' }>,
  period: number,
  doc: Document,
): Series[] {
  let values: ArrayLike<number>;
  if (spec.table === 'node') {
    // EPANET's frequency plot covers junctions only.
    const frame = nodeFrame(run.results, spec.variable, period);
    values = Array.from(run.nodes, (h, i) =>
      doc.has(h) && doc.nodeKind(h) === 'junction' ? frame[i]! : NaN,
    );
  } else {
    values = linkFrame(run.results, spec.variable, period);
  }
  const f = frequency(values, spec.table === 'link' && spec.variable === 'flow');
  return [{ name: spec.variable, x: f.x, y: f.y }];
}

/**
 * The system flow balance over time: water produced (supplied by reservoirs,
 * emptying tanks and negative demands) and consumed (positive junction demands).
 */
export function systemFlow(doc: Document, run: RunIndex): Series[] {
  const r = run.results;
  const x = hours(r);
  const produced = new Float64Array(r.times.length);
  const consumed = new Float64Array(r.times.length);
  const isJunction = Array.from(run.nodes, (h) => doc.has(h) && doc.nodeKind(h) === 'junction');
  for (let p = 0; p < r.times.length; p++) {
    const d = nodeFrame(r, 'demand', p);
    let prod = 0;
    let cons = 0;
    for (let i = 0; i < d.length; i++) {
      const v = d[i]!;
      if (v < 0) prod -= v;
      else if (isJunction[i]) cons += v;
    }
    produced[p] = prod;
    consumed[p] = cons;
  }
  return [
    { name: 'Produced', x, y: produced },
    { name: 'Consumed', x, y: consumed },
  ];
}

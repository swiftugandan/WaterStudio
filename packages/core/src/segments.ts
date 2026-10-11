/**
 * Isolation segments: the parts of a network that closing isolation valves cuts out.
 * Each pipe is joined to its end nodes except where a valve sits at that end; pumps
 * and control valves are boundaries, as they can be shut. A segment is a connected
 * group of nodes and links; closing the valves around it isolates it, and may cut off
 * further nodes from every reservoir and tank ("unintended isolation").
 */

import type { Document, IsolationValve } from './document.ts';

export interface Segment {
  /** Element handles: nodes and links. */
  nodes: number[];
  links: number[];
  /** Valves that bound the segment, as [link handle, node handle]. */
  valves: [number, number][];
  /** Total pipe length in the segment, in model units. */
  length: number;
}

export interface SegmentResult {
  segments: Segment[];
  /** The segment index of every node and link handle. */
  of: Map<number, number>;
}

export function segments(doc: Document, valves: readonly IsolationValve[]): SegmentResult {
  const at = new Set<string>();
  for (const v of valves) {
    const l = doc.findLink(v.link);
    const n = doc.findNode(v.node);
    if (l !== undefined && n !== undefined) at.add(`${l}:${n}`);
  }
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    let c = x;
    while (parent.get(c) !== r) {
      const next = parent.get(c)!;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const h of doc.nodeHandles()) parent.set(h, h);
  for (const h of doc.linkHandles()) parent.set(h, h);
  const bounds: [number, number][] = [];
  for (const l of doc.linkHandles()) {
    const from = doc.num(l, 'from');
    const to = doc.num(l, 'to');
    const pipe = doc.linkKind(l) === 'pipe';
    for (const n of [from, to]) {
      if (pipe && !at.has(`${l}:${n}`)) union(l, n);
      else bounds.push([l, n]);
    }
  }
  const index = new Map<number, number>();
  const list: Segment[] = [];
  const seg = (root: number) => {
    let i = index.get(root);
    if (i === undefined) {
      i = list.length;
      index.set(root, i);
      list.push({ nodes: [], links: [], valves: [], length: 0 });
    }
    return list[i]!;
  };
  const of = new Map<number, number>();
  for (const h of doc.nodeHandles()) {
    seg(find(h)).nodes.push(h);
    of.set(h, index.get(find(h))!);
  }
  for (const l of doc.linkHandles()) {
    const s = seg(find(l));
    s.links.push(l);
    if (doc.linkKind(l) === 'pipe') s.length += doc.num(l, 'length');
    of.set(l, index.get(find(l))!);
  }
  // A boundary belongs to the segments on both of its sides.
  for (const [l, n] of bounds) {
    const a = of.get(l)!;
    const b = of.get(n)!;
    if (doc.linkKind(l) === 'pipe') list[a]!.valves.push([l, n]);
    if (b !== a && doc.linkKind(l) === 'pipe') list[b]!.valves.push([l, n]);
  }
  return { segments: list, of };
}

/**
 * Closing segment `i`: the nodes cut off from every reservoir and tank as well, beyond
 * the segment itself (pumps and control valves stay open).
 */
export function cutOff(doc: Document, result: SegmentResult, i: number): number[] {
  const out = new Set(result.segments[i]?.nodes ?? []);
  const closed = new Set(result.segments[i]?.links ?? []);
  const adj = new Map<number, number[]>();
  for (const l of doc.linkHandles()) {
    if (closed.has(l)) continue;
    const a = doc.num(l, 'from');
    const b = doc.num(l, 'to');
    if (out.has(a) || out.has(b)) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const stack: number[] = [];
  for (const h of doc.nodeHandles())
    if (doc.nodeKind(h) !== 'junction' && !out.has(h)) {
      seen.add(h);
      stack.push(h);
    }
  while (stack.length) {
    const n = stack.pop()!;
    for (const m of adj.get(n) ?? [])
      if (!seen.has(m)) {
        seen.add(m);
        stack.push(m);
      }
  }
  const lost: number[] = [];
  for (const h of doc.nodeHandles()) if (!seen.has(h) && !out.has(h)) lost.push(h);
  return lost;
}

/** Valves at both ends of every pipe: every pipe its own segment. */
export function valvesEveryEnd(doc: Document): IsolationValve[] {
  const out: IsolationValve[] = [];
  for (const l of doc.linkHandles()) {
    if (doc.linkKind(l) !== 'pipe') continue;
    for (const n of [doc.num(l, 'from'), doc.num(l, 'to')]) out.push({ link: doc.id(l), node: doc.id(n) });
  }
  return out;
}

/** The N−1 rule: at each node joining k pipes, valves on all but one (the longest stays unvalved). */
export function valvesNMinusOne(doc: Document): IsolationValve[] {
  const out: IsolationValve[] = [];
  for (const n of doc.nodeHandles()) {
    const pipes = doc.linksAt(n).filter((l) => doc.linkKind(l) === 'pipe');
    if (pipes.length < 2) continue;
    const keep = pipes.reduce((a, b) => (doc.num(b, 'length') > doc.num(a, 'length') ? b : a));
    for (const l of pipes) if (l !== keep) out.push({ link: doc.id(l), node: doc.id(n) });
  }
  return out;
}

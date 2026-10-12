/**
 * The scene: the backend-neutral display list built from a document. Geometry is in
 * f32 relative to an f64 origin near the network, so it stays precise at street zoom
 * without f64 on the GPU. Element indices follow the document's live element order,
 * which is also the order of engine results, so a result column maps straight onto
 * the scene.
 */

import { VALVE_TYPES, type Document } from '@waterstudio/core';
import type { Bounds } from './camera.ts';

/** What is drawn at a link's midpoint. */
export const LINK_SYMBOLS = [
  'none',
  'check-valve',
  'pump',
  'valve-prv',
  'valve-psv',
  'valve-pbv',
  'valve-fcv',
  'valve-tcv',
  'valve-gpv',
  'valve-pcv',
] as const;
export type LinkSymbol = (typeof LINK_SYMBOLS)[number];

export const NODE_SHAPES = ['junction', 'reservoir', 'tank'] as const;

export interface Scene {
  rev: number;
  originX: number;
  originY: number;
  /** World bounds of everything drawable; empty networks get a unit box. */
  bounds: Bounds;
  nodeCount: number;
  nodeHandles: Uint32Array;
  /** Index into NODE_SHAPES. */
  nodeKind: Uint8Array;
  /** x, y relative to the origin; NaN for nodes without coordinates. */
  nodeXY: Float32Array;
  linkCount: number;
  linkHandles: Uint32Array;
  /** Index into LINK_SYMBOLS. */
  linkSymbol: Uint8Array;
  segCount: number;
  /** ax, ay, bx, by per segment, relative to the origin. */
  segXY: Float32Array;
  /** Link index of each segment. */
  segLink: Uint32Array;
  symCount: number;
  /** Midpoint x, y and bearing (radians, counter-clockwise from +x) of each link symbol. */
  symXY: Float32Array;
  symAngle: Float32Array;
  symLink: Uint32Array;
  symKind: Uint8Array;
  /** Each link's first segment (its segments are consecutive), or -1 if it is not drawn. */
  segFirst: Int32Array;
  /** Each link's symbol index, or -1. */
  linkSym: Int32Array;
  /** Median drawn segment length in world units, for level of detail. */
  typicalLength: number;
}

/** New positions for a few elements of a scene (`patchScene`), applied as they are. */
export interface ScenePatch {
  nodes: Uint32Array;
  /** x, y per patched node. */
  nodeXY: Float32Array;
  segs: Uint32Array;
  /** ax, ay, bx, by per patched segment. */
  segXY: Float32Array;
  syms: Uint32Array;
  /** x, y per patched symbol. */
  symXY: Float32Array;
  symAngle: Float32Array;
}

const VALVE_SYMBOL: Record<(typeof VALVE_TYPES)[number], LinkSymbol> = {
  prv: 'valve-prv',
  psv: 'valve-psv',
  pbv: 'valve-pbv',
  fcv: 'valve-fcv',
  tcv: 'valve-tcv',
  gpv: 'valve-gpv',
  pcv: 'valve-pcv',
};

export function linkSymbolOf(doc: Document, h: number): LinkSymbol {
  switch (doc.linkKind(h)) {
    case 'pipe':
      return doc.num(h, 'pipeStatus') === 2 ? 'check-valve' : 'none';
    case 'pump':
      return 'pump';
    case 'valve':
      return VALVE_SYMBOL[VALVE_TYPES[doc.num(h, 'valveType')] ?? 'tcv'];
  }
}

export function buildScene(doc: Document, rev = 0): Scene {
  const nodes = doc.nodes;
  const nodeCount = nodes.liveCount;
  const nodeHandles = new Uint32Array(nodeCount);
  const nodeKind = new Uint8Array(nodeCount);
  const worldX = new Float64Array(nodeCount);
  const worldY = new Float64Array(nodeCount);
  const indexOf = new Map<number, number>();
  const xs = nodes.column('x').data as Float64Array;
  const ys = nodes.column('y').data as Float64Array;
  const kinds = nodes.column('kind').data as Uint8Array;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const grow = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };

  let i = 0;
  for (let r = 0; r < nodes.length; r++) {
    if (nodes.alive[r] !== 1) continue;
    const h = nodes.handles[r]!;
    nodeHandles[i] = h;
    nodeKind[i] = kinds[r]!;
    worldX[i] = xs[r]!;
    worldY[i] = ys[r]!;
    if (!Number.isNaN(xs[r]!) && !Number.isNaN(ys[r]!)) grow(xs[r]!, ys[r]!);
    indexOf.set(h, i);
    i++;
  }

  const links = doc.links;
  const linkCount = links.liveCount;
  const linkHandles = new Uint32Array(linkCount);
  const linkSymbol = new Uint8Array(linkCount);
  const from = links.column('from').data as Uint32Array;
  const to = links.column('to').data as Uint32Array;
  const vertsCol = links.column('vertices');

  // First pass: count segments and grow bounds with vertices.
  let segCount = 0;
  let symCount = 0;
  i = 0;
  const linkRows: number[] = [];
  for (let r = 0; r < links.length; r++) {
    if (links.alive[r] !== 1) continue;
    const h = links.handles[r]!;
    linkHandles[i] = h;
    const sym = LINK_SYMBOLS.indexOf(linkSymbolOf(doc, h));
    linkSymbol[i] = sym;
    const a = indexOf.get(from[r]!);
    const b = indexOf.get(to[r]!);
    const verts = vertsCol.get(r) as number[];
    if (a !== undefined && b !== undefined && !Number.isNaN(worldX[a]!) && !Number.isNaN(worldX[b]!)) {
      segCount += verts.length / 2 + 1;
      for (let k = 0; k + 1 < verts.length; k += 2) grow(verts[k]!, verts[k + 1]!);
      if (sym !== 0) symCount++;
      linkRows.push(r, i, a, b);
    }
    i++;
  }

  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;

  const nodeXY = new Float32Array(nodeCount * 2);
  for (let k = 0; k < nodeCount; k++) {
    nodeXY[2 * k] = worldX[k]! - originX;
    nodeXY[2 * k + 1] = worldY[k]! - originY;
  }

  const segXY = new Float32Array(segCount * 4);
  const segLink = new Uint32Array(segCount);
  const symXY = new Float32Array(symCount * 2);
  const symAngle = new Float32Array(symCount);
  const symLink = new Uint32Array(symCount);
  const symKind = new Uint8Array(symCount);
  const segFirst = new Int32Array(linkCount).fill(-1);
  const linkSym = new Int32Array(linkCount).fill(-1);
  const lengths: number[] = [];
  let s = 0;
  let m = 0;
  const pts: number[] = [];
  for (let q = 0; q < linkRows.length; q += 4) {
    const r = linkRows[q]!;
    const li = linkRows[q + 1]!;
    const a = linkRows[q + 2]!;
    const b = linkRows[q + 3]!;
    const verts = vertsCol.get(r) as number[];
    pts.length = 0;
    pts.push(worldX[a]! - originX, worldY[a]! - originY);
    for (let k = 0; k + 1 < verts.length; k += 2) pts.push(verts[k]! - originX, verts[k + 1]! - originY);
    pts.push(worldX[b]! - originX, worldY[b]! - originY);
    segFirst[li] = s;
    let total = 0;
    for (let k = 0; k + 3 < pts.length; k += 2) {
      segXY[4 * s] = pts[k]!;
      segXY[4 * s + 1] = pts[k + 1]!;
      segXY[4 * s + 2] = pts[k + 2]!;
      segXY[4 * s + 3] = pts[k + 3]!;
      segLink[s] = li;
      const len = Math.hypot(pts[k + 2]! - pts[k]!, pts[k + 3]! - pts[k + 1]!);
      total += len;
      if (len > 0) lengths.push(len);
      s++;
    }
    const sym = linkSymbol[li]!;
    if (sym !== 0) {
      const [px, py, angle] = midpoint(pts, total);
      linkSym[li] = m;
      symXY[2 * m] = px;
      symXY[2 * m + 1] = py;
      symAngle[m] = angle;
      symLink[m] = li;
      symKind[m] = sym;
      m++;
    }
  }

  lengths.sort((x, y) => x - y);
  const typicalLength =
    lengths.length > 0 ? lengths[lengths.length >> 1]! : Math.max(maxX - minX, maxY - minY) / 10 || 1;

  return {
    rev,
    originX,
    originY,
    bounds: { minX, minY, maxX, maxY },
    nodeCount,
    nodeHandles,
    nodeKind,
    nodeXY,
    linkCount,
    linkHandles,
    linkSymbol,
    segCount,
    segXY,
    segLink,
    symCount,
    symXY,
    symAngle,
    symLink,
    symKind,
    segFirst,
    linkSym,
    typicalLength,
  };
}

/** The midpoint along a polyline [x, y, ...] of length `total`, and the bearing there. */
function midpoint(pts: readonly number[], total: number): [number, number, number] {
  let half = total / 2;
  let px = pts[0]!;
  let py = pts[1]!;
  let angle = 0;
  for (let k = 0; k + 3 < pts.length; k += 2) {
    const dx = pts[k + 2]! - pts[k]!;
    const dy = pts[k + 3]! - pts[k + 1]!;
    const len = Math.hypot(dx, dy);
    angle = Math.atan2(dy, dx);
    if (len >= half || k + 4 >= pts.length) {
      const t = len > 0 ? Math.min(1, half / len) : 0;
      px = pts[k]! + dx * t;
      py = pts[k + 1]! + dy * t;
      break;
    }
    half -= len;
  }
  return [px, py, angle];
}

/**
 * Move a few elements of a scene to where the document now has them, in place, and
 * return what changed for the renderer. `nodes` and `links` are scene indices: nodes
 * that moved, and links whose ends or vertices moved. Null when the change needs a new
 * scene instead: a link gains or loses vertices or coordinates, or something leaves
 * the scene's bounds.
 */
export function patchScene(
  scene: Scene,
  doc: Document,
  nodes: readonly number[],
  links: readonly number[],
): ScenePatch | null {
  const b = scene.bounds;
  const ox = scene.originX;
  const oy = scene.originY;
  const inside = (x: number, y: number) => x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY;
  const nodeXY = new Float32Array(nodes.length * 2);
  for (let k = 0; k < nodes.length; k++) {
    const i = nodes[k]!;
    const h = scene.nodeHandles[i]!;
    if (!doc.has(h)) return null;
    const x = doc.num(h, 'x');
    const y = doc.num(h, 'y');
    if (Number.isNaN(x) || Number.isNaN(y) || Number.isNaN(scene.nodeXY[2 * i]!) || !inside(x, y))
      return null;
    nodeXY[2 * k] = x - ox;
    nodeXY[2 * k + 1] = y - oy;
    scene.nodeXY[2 * i] = nodeXY[2 * k]!;
    scene.nodeXY[2 * i + 1] = nodeXY[2 * k + 1]!;
  }
  const segs: number[] = [];
  const segXY: number[] = [];
  const syms: number[] = [];
  const symXY: number[] = [];
  const symAngle: number[] = [];
  const nodeIndex = new Map<number, number>();
  const indexOfNode = (h: number): number | undefined => {
    if (nodeIndex.size === 0) scene.nodeHandles.forEach((x, i) => nodeIndex.set(x, i));
    return nodeIndex.get(h);
  };
  const pts: number[] = [];
  for (const li of links) {
    const h = scene.linkHandles[li]!;
    const first = scene.segFirst[li]!;
    if (first < 0 || !doc.has(h)) return null;
    let n = 0;
    while (first + n < scene.segCount && scene.segLink[first + n] === li) n++;
    const verts = doc.get(h, 'vertices') as number[];
    if (verts.length / 2 + 1 !== n) return null;
    const a = indexOfNode(doc.num(h, 'from'));
    const c = indexOfNode(doc.num(h, 'to'));
    if (a === undefined || c === undefined) return null;
    pts.length = 0;
    pts.push(scene.nodeXY[2 * a]!, scene.nodeXY[2 * a + 1]!);
    for (let k = 0; k + 1 < verts.length; k += 2) {
      if (!inside(verts[k]!, verts[k + 1]!)) return null;
      pts.push(verts[k]! - ox, verts[k + 1]! - oy);
    }
    pts.push(scene.nodeXY[2 * c]!, scene.nodeXY[2 * c + 1]!);
    if (pts.some(Number.isNaN)) return null;
    let total = 0;
    for (let k = 0; k < n; k++) {
      const q = first + k;
      const quad = [pts[2 * k]!, pts[2 * k + 1]!, pts[2 * k + 2]!, pts[2 * k + 3]!];
      scene.segXY.set(quad, 4 * q);
      total += Math.hypot(quad[2]! - quad[0]!, quad[3]! - quad[1]!);
      segs.push(q);
      segXY.push(...quad);
    }
    const m = scene.linkSym[li]!;
    if (m >= 0) {
      const [px, py, angle] = midpoint(pts, total);
      scene.symXY[2 * m] = px;
      scene.symXY[2 * m + 1] = py;
      scene.symAngle[m] = angle;
      syms.push(m);
      symXY.push(px, py);
      symAngle.push(angle);
    }
  }
  return {
    nodes: Uint32Array.from(nodes),
    nodeXY,
    segs: Uint32Array.from(segs),
    segXY: Float32Array.from(segXY),
    syms: Uint32Array.from(syms),
    symXY: Float32Array.from(symXY),
    symAngle: Float32Array.from(symAngle),
  };
}

/** Apply a patch made by `patchScene` to another copy of the same scene (the worker's). */
export function applyScenePatch(scene: Scene, p: ScenePatch): void {
  p.nodes.forEach((i, k) => {
    scene.nodeXY[2 * i] = p.nodeXY[2 * k]!;
    scene.nodeXY[2 * i + 1] = p.nodeXY[2 * k + 1]!;
  });
  p.segs.forEach((q, k) => scene.segXY.set(p.segXY.subarray(4 * k, 4 * k + 4), 4 * q));
  p.syms.forEach((m, k) => {
    scene.symXY[2 * m] = p.symXY[2 * k]!;
    scene.symXY[2 * m + 1] = p.symXY[2 * k + 1]!;
    scene.symAngle[m] = p.symAngle[k]!;
  });
}

/** Buffers of a scene, for transferring it to a worker. */
export function sceneBuffers(s: Scene): ArrayBuffer[] {
  return [
    s.nodeHandles,
    s.nodeKind,
    s.nodeXY,
    s.linkHandles,
    s.linkSymbol,
    s.segXY,
    s.segLink,
    s.symXY,
    s.symAngle,
    s.symLink,
    s.symKind,
    s.segFirst,
    s.linkSym,
  ].map((a) => a.buffer as ArrayBuffer);
}

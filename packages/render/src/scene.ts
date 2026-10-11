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
  /** Median drawn segment length in world units, for level of detail. */
  typicalLength: number;
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
      // Midpoint along the polyline, and the bearing of the segment it falls on.
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
    typicalLength,
  };
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
  ].map((a) => a.buffer as ArrayBuffer);
}

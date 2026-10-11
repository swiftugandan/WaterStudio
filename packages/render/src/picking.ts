/**
 * Hit testing on CPU geometry, independent of the backend: packed R-trees (flatbush)
 * over node points and link segments, built once per scene.
 */

import Flatbush from 'flatbush';
import type { Bounds, Camera } from './camera.ts';
import type { Scene } from './scene.ts';

export interface Hit {
  table: 'node' | 'link';
  handle: number;
  /** Index in the scene (and in result columns). */
  index: number;
  /** Distance from the point in CSS pixels. */
  distance: number;
}

function segDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Picker {
  private readonly nodes: Flatbush | null;
  private readonly segs: Flatbush | null;
  private readonly nodeIds: number[] = [];
  private readonly scene: Scene;

  constructor(scene: Scene) {
    this.scene = scene;
    const s = scene;
    const drawn: number[] = [];
    for (let i = 0; i < s.nodeCount; i++) if (!Number.isNaN(s.nodeXY[2 * i]!)) drawn.push(i);
    this.nodeIds = drawn;
    if (drawn.length > 0) {
      const fb = new Flatbush(drawn.length);
      for (const i of drawn) fb.add(s.nodeXY[2 * i]!, s.nodeXY[2 * i + 1]!);
      fb.finish();
      this.nodes = fb;
    } else this.nodes = null;
    if (s.segCount > 0) {
      const fb = new Flatbush(s.segCount);
      const xy = s.segXY;
      for (let i = 0; i < s.segCount; i++) {
        const ax = xy[4 * i]!;
        const ay = xy[4 * i + 1]!;
        const bx = xy[4 * i + 2]!;
        const by = xy[4 * i + 3]!;
        fb.add(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by));
      }
      fb.finish();
      this.segs = fb;
    } else this.segs = null;
  }

  /** The element nearest a screen point within `tolerance` CSS pixels; nodes win ties. */
  pick(camera: Camera, sx: number, sy: number, tolerance = 6): Hit | null {
    const s = this.scene;
    const [wx, wy] = camera.toWorld(sx, sy);
    const px = wx - s.originX;
    const py = wy - s.originY;
    const r = tolerance / camera.scale;
    if (this.nodes) {
      const found = this.nodes.neighbors(px, py, 1, r);
      const k = found[0];
      if (k !== undefined) {
        const i = this.nodeIds[k]!;
        const d = Math.hypot(s.nodeXY[2 * i]! - px, s.nodeXY[2 * i + 1]! - py) * camera.scale;
        return { table: 'node', handle: s.nodeHandles[i]!, index: i, distance: d };
      }
    }
    if (this.segs) {
      let best: Hit | null = null;
      for (const k of this.segs.search(px - r, py - r, px + r, py + r)) {
        const xy = s.segXY;
        const d =
          segDistance(px, py, xy[4 * k]!, xy[4 * k + 1]!, xy[4 * k + 2]!, xy[4 * k + 3]!) * camera.scale;
        if (d <= tolerance && (!best || d < best.distance)) {
          const li = s.segLink[k]!;
          best = { table: 'link', handle: s.linkHandles[li]!, index: li, distance: d };
        }
      }
      return best;
    }
    return null;
  }

  /**
   * Elements in a world rectangle. `crossing` also takes links that cross it; otherwise
   * only links lying entirely inside are taken (window selection).
   */
  query(b: Bounds, crossing = false): { nodes: number[]; links: number[] } {
    const s = this.scene;
    const minX = b.minX - s.originX;
    const minY = b.minY - s.originY;
    const maxX = b.maxX - s.originX;
    const maxY = b.maxY - s.originY;
    const nodes = this.nodes ? this.nodes.search(minX, minY, maxX, maxY).map((k) => this.nodeIds[k]!) : [];
    const inside = (x: number, y: number) => x >= minX && x <= maxX && y >= minY && y <= maxY;
    const links = new Set<number>();
    if (this.segs) {
      const candidates = new Set<number>();
      for (const k of this.segs.search(minX, minY, maxX, maxY)) candidates.add(s.segLink[k]!);
      if (crossing) {
        for (const li of candidates) links.add(li);
      } else {
        const outside = new Set<number>();
        for (let k = 0; k < s.segCount; k++) {
          const li = s.segLink[k]!;
          if (!candidates.has(li)) continue;
          const xy = s.segXY;
          if (!inside(xy[4 * k]!, xy[4 * k + 1]!) || !inside(xy[4 * k + 2]!, xy[4 * k + 3]!)) outside.add(li);
        }
        for (const li of candidates) if (!outside.has(li)) links.add(li);
      }
    }
    return { nodes, links: [...links] };
  }
}

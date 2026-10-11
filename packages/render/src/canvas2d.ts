/**
 * The Canvas 2D backend: the same scene as WebGPU, drawn into a 2D context (usually an
 * OffscreenCanvas in the render worker).
 *
 * - Links are batched into one Path2D per colour class, so draw calls scale with legend
 *   classes, not elements; junctions likewise.
 * - The network (links and junctions) is rasterised into a cache bitmap that covers the
 *   view plus a margin. Panning blits the cache; it is redrawn only when the view leaves
 *   it, the zoom changes, or the network, colours or hidden elements change.
 * - Zoomed in, paths hold only what lies near the view, found through a uniform grid.
 * - Selection, hover and symbols are few, and are drawn live on top every frame.
 */

import { atlasIndex, ATLAS_SYMBOLS, type Atlas } from './atlas.ts';
import type { Backend, Frame } from './backend.ts';
import { Grid } from './grid.ts';
import { LINK_SYMBOLS, type Scene } from './scene.ts';
import {
  defaultDrawOptions,
  FLAG_HIDDEN,
  FLAG_HOVER,
  FLAG_SELECTED,
  type DrawOptions,
  type Paint,
  type Theme,
} from './style.ts';

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type Rect = [number, number, number, number];

const NODE_ATLAS = [-1, atlasIndex('reservoir'), atlasIndex('tank')];
const LINK_ATLAS = LINK_SYMBOLS.map((s) => (s === 'none' ? -1 : ATLAS_SYMBOLS.indexOf(s)));
/** The cache covers the view plus this fraction of it on every side. */
const MARGIN = 0.5;

interface Cache {
  canvas: OffscreenCanvas;
  ctx: OffscreenCanvasRenderingContext2D;
  /** Scene rectangle the cache covers. */
  rect: Rect;
  scale: number;
  dpr: number;
}

export class Canvas2DBackend implements Backend {
  readonly name = 'canvas2d' as const;
  private readonly ctx: Ctx;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private scene: Scene | null = null;
  private paint: Paint | null = null;
  private nodeFlags: Uint8Array = new Uint8Array(0);
  private linkFlags: Uint8Array = new Uint8Array(0);
  private theme: Theme | null = null;
  private atlas: Atlas | null = null;
  private options: DrawOptions = defaultDrawOptions;
  private segGrid: Grid | null = null;
  private nodeGrid: Grid | null = null;
  private cache: Cache | null = null;
  private cacheValid = false;
  private highlight: { links: Path2D; hover: Path2D; nodes: number[]; hoverNodes: number[] } | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d', { alpha: false }) as Ctx | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    const b = scene.bounds;
    const rel = {
      minX: b.minX - scene.originX,
      minY: b.minY - scene.originY,
      maxX: b.maxX - scene.originX,
      maxY: b.maxY - scene.originY,
    };
    const xy = scene.segXY;
    this.segGrid = new Grid(scene.segCount, rel, (i, out) => {
      out[0] = Math.min(xy[4 * i]!, xy[4 * i + 2]!);
      out[1] = Math.min(xy[4 * i + 1]!, xy[4 * i + 3]!);
      out[2] = Math.max(xy[4 * i]!, xy[4 * i + 2]!);
      out[3] = Math.max(xy[4 * i + 1]!, xy[4 * i + 3]!);
    });
    const nxy = scene.nodeXY;
    this.nodeGrid = new Grid(scene.nodeCount, rel, (i, out) => {
      out[0] = out[2] = nxy[2 * i]!;
      out[1] = out[3] = nxy[2 * i + 1]!;
    });
    this.cacheValid = false;
    this.highlight = null;
  }

  setPaint(paint: Paint): void {
    this.paint = paint;
    this.cacheValid = false;
  }

  setFlags(node: Uint8Array, link: Uint8Array): void {
    // Hidden elements are part of the cached image; selection and hover are not.
    if (hiddenChanged(this.nodeFlags, node) || hiddenChanged(this.linkFlags, link)) this.cacheValid = false;
    this.nodeFlags = node;
    this.linkFlags = link;
    this.highlight = null;
  }

  setTheme(theme: Theme, atlas: Atlas | null): void {
    this.theme = theme;
    this.atlas = atlas;
    this.cacheValid = false;
  }

  setOptions(options: DrawOptions): void {
    this.options = options;
    this.cacheValid = false;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    this.cacheValid = false;
  }

  /** Visit items whose grid cells overlap `r`, or every item when the grid is missing. */
  private each(grid: Grid | null, count: number, r: Rect | null, fn: (i: number) => void): void {
    if (!r || !grid) {
      for (let i = 0; i < count; i++) fn(i);
      return;
    }
    grid.query(r[0], r[1], r[2], r[3], fn);
  }

  private drawNetwork(ctx: Ctx, s: Scene, t: Theme, scale: number, region: Rect | null): void {
    const classes = this.paint?.linkClass;
    const linkColors = [t.link, ...(this.paint?.linkLegend?.colors ?? [])];
    const paths = linkColors.map(() => new Path2D());
    const xy = s.segXY;
    this.each(this.segGrid, s.segCount, region, (i) => {
      const li = s.segLink[i]!;
      if ((this.linkFlags[li] ?? 0) & FLAG_HIDDEN) return;
      const p = paths[classes?.[li] ?? 0] ?? paths[0]!;
      p.moveTo(xy[4 * i]!, xy[4 * i + 1]!);
      p.lineTo(xy[4 * i + 2]!, xy[4 * i + 3]!);
    });
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = this.options.linkWidth / scale;
    paths.forEach((p, k) => {
      ctx.strokeStyle = linkColors[k] ?? t.link;
      ctx.stroke(p);
    });

    if (s.typicalLength * scale < this.options.junctionMinSpacing) return;
    const nodeClasses = this.paint?.nodeClass;
    const nodeColors = [t.node, ...(this.paint?.nodeLegend?.colors ?? [])];
    const dots = nodeColors.map(() => new Path2D());
    const r = this.options.nodeRadius / scale;
    const nxy = s.nodeXY;
    this.each(this.nodeGrid, s.nodeCount, region, (i) => {
      if (s.nodeKind[i] !== 0 || (this.nodeFlags[i] ?? 0) & FLAG_HIDDEN) return;
      const x = nxy[2 * i]!;
      const y = nxy[2 * i + 1]!;
      if (Number.isNaN(x)) return;
      const p = dots[nodeClasses?.[i] ?? 0] ?? dots[0]!;
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, 2 * Math.PI);
    });
    dots.forEach((p, k) => {
      ctx.fillStyle = nodeColors[k] ?? t.node;
      ctx.fill(p);
    });
  }

  private buildHighlight(s: Scene): void {
    const links = new Path2D();
    const hover = new Path2D();
    const xy = s.segXY;
    for (let i = 0; i < s.segCount; i++) {
      const f = this.linkFlags[s.segLink[i]!] ?? 0;
      if (!(f & (FLAG_SELECTED | FLAG_HOVER)) || f & FLAG_HIDDEN) continue;
      const p = f & FLAG_SELECTED ? links : hover;
      p.moveTo(xy[4 * i]!, xy[4 * i + 1]!);
      p.lineTo(xy[4 * i + 2]!, xy[4 * i + 3]!);
    }
    const nodes: number[] = [];
    const hoverNodes: number[] = [];
    for (let i = 0; i < s.nodeCount; i++) {
      const f = this.nodeFlags[i] ?? 0;
      if (f & FLAG_HIDDEN) continue;
      if (f & FLAG_SELECTED) nodes.push(i);
      else if (f & FLAG_HOVER) hoverNodes.push(i);
    }
    this.highlight = { links, hover, nodes, hoverNodes };
  }

  /** Make sure the cache holds the network around the view at this scale. */
  private ensureCache(s: Scene, t: Theme, frame: Frame): Cache | null {
    const { camera, dpr } = frame;
    const scale = camera.scale;
    const hw = camera.width / 2 / scale;
    const hh = camera.height / 2 / scale;
    const vx = camera.cx - s.originX;
    const vy = camera.cy - s.originY;
    const c = this.cache;
    if (
      this.cacheValid &&
      c &&
      c.scale === scale &&
      c.dpr === dpr &&
      vx - hw >= c.rect[0] &&
      vx + hw <= c.rect[2] &&
      vy - hh >= c.rect[1] &&
      vy + hh <= c.rect[3]
    ) {
      return c;
    }
    const mx = hw * (1 + 2 * MARGIN);
    const my = hh * (1 + 2 * MARGIN);
    const rect: Rect = [vx - mx, vy - my, vx + mx, vy + my];
    const w = Math.ceil(2 * mx * scale * dpr);
    const h = Math.ceil(2 * my * scale * dpr);
    if (w > 16384 || h > 16384) return null;
    let canvas = c?.canvas;
    let ctx = c?.ctx;
    if (!canvas || !ctx || canvas.width !== w || canvas.height !== h) {
      canvas = new OffscreenCanvas(w, h);
      const next = canvas.getContext('2d');
      if (!next) return null;
      ctx = next;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t.background;
    ctx.fillRect(0, 0, w, h);
    // Scene coordinates to cache pixels: the cache's top left is (rect[0], rect[3]).
    ctx.setTransform(scale * dpr, 0, 0, -scale * dpr, -rect[0] * scale * dpr, rect[3] * scale * dpr);
    const b = s.bounds;
    const covers =
      rect[0] <= b.minX - s.originX &&
      rect[1] <= b.minY - s.originY &&
      rect[2] >= b.maxX - s.originX &&
      rect[3] >= b.maxY - s.originY;
    // Pad the query by a link width so strokes crossing the edge are drawn.
    const pad = (this.options.linkWidth + this.options.nodeRadius) / scale;
    const region: Rect | null = covers ? null : [rect[0] - pad, rect[1] - pad, rect[2] + pad, rect[3] + pad];
    this.drawNetwork(ctx, s, t, scale, region);
    this.cache = { canvas, ctx, rect, scale, dpr };
    this.cacheValid = true;
    return this.cache;
  }

  render(frame: Frame): void {
    const { camera, dpr } = frame;
    const ctx = this.ctx;
    const t = this.theme;
    const s = this.scene;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = t?.background ?? '#ffffff';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!s || !t) return;

    const scale = camera.scale;
    // Scene coordinates to device pixels.
    const tx = ((s.originX - camera.cx) * scale + camera.width / 2) * dpr;
    const ty = (camera.height / 2 - (s.originY - camera.cy) * scale) * dpr;

    const cache = this.ensureCache(s, t, frame);
    if (cache) {
      ctx.drawImage(
        cache.canvas,
        Math.round(cache.rect[0] * scale * dpr + tx),
        Math.round(-cache.rect[3] * scale * dpr + ty),
      );
    } else {
      // Too large to cache (extreme zoom on a huge display): draw directly.
      ctx.setTransform(scale * dpr, 0, 0, -scale * dpr, tx, ty);
      const hw = camera.width / 2 / scale;
      const hh = camera.height / 2 / scale;
      const vx = camera.cx - s.originX;
      const vy = camera.cy - s.originY;
      this.drawNetwork(ctx, s, t, scale, [vx - hw, vy - hh, vx + hw, vy + hh]);
    }

    // Selection and hover, live.
    if (!this.highlight) this.buildHighlight(s);
    const hl = this.highlight!;
    ctx.setTransform(scale * dpr, 0, 0, -scale * dpr, tx, ty);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = (this.options.linkWidth * 2.5) / scale;
    ctx.strokeStyle = t.selection;
    ctx.stroke(hl.links);
    ctx.strokeStyle = t.hover;
    ctx.stroke(hl.hover);
    const ring = (list: number[], color: string) => {
      if (list.length === 0) return;
      const p = new Path2D();
      const rs = (this.options.nodeRadius + 2.5) / scale;
      for (const i of list) {
        if (s.nodeKind[i] !== 0) continue;
        const x = s.nodeXY[2 * i]!;
        const y = s.nodeXY[2 * i + 1]!;
        p.moveTo(x + rs, y);
        p.arc(x, y, rs, 0, 2 * Math.PI);
      }
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = color;
      ctx.stroke(p);
    };
    ring(hl.nodes, t.selection);
    ring(hl.hoverNodes, t.hover);

    // Symbols, drawn upright in screen space.
    const atlas = this.atlas;
    if (!atlas) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const size = this.options.symbolSize * dpr;
    const cell = atlas.cell;
    const toScreenX = (x: number) => x * scale * dpr + tx;
    const toScreenY = (y: number) => -y * scale * dpr + ty;
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (let i = 0; i < s.nodeCount; i++) {
      const a = NODE_ATLAS[s.nodeKind[i]!] ?? -1;
      if (a < 0) continue;
      const f = this.nodeFlags[i] ?? 0;
      if (f & FLAG_HIDDEN) continue;
      const x = toScreenX(s.nodeXY[2 * i]!);
      const y = toScreenY(s.nodeXY[2 * i + 1]!);
      if (x < -size || y < -size || x > w + size || y > h + size) continue;
      const row = f & FLAG_SELECTED ? 1 : 0;
      ctx.drawImage(atlas.bitmap, a * cell, row * cell, cell, cell, x - size / 2, y - size / 2, size, size);
    }
    if (s.typicalLength * scale >= this.options.symbolSize) {
      for (let i = 0; i < s.symCount; i++) {
        const li = s.symLink[i]!;
        const f = this.linkFlags[li] ?? 0;
        if (f & FLAG_HIDDEN) continue;
        const a = LINK_ATLAS[s.symKind[i]!] ?? -1;
        if (a < 0) continue;
        const x = toScreenX(s.symXY[2 * i]!);
        const y = toScreenY(s.symXY[2 * i + 1]!);
        if (x < -size || y < -size || x > w + size || y > h + size) continue;
        const row = f & FLAG_SELECTED ? 1 : 0;
        ctx.setTransform(1, 0, 0, 1, x, y);
        ctx.rotate(-s.symAngle[i]!);
        ctx.drawImage(atlas.bitmap, a * cell, row * cell, cell, cell, -size / 2, -size / 2, size, size);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  }

  destroy(): void {
    this.scene = null;
    this.cache = null;
  }
}

function hiddenChanged(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if ((a[i]! ^ b[i]!) & FLAG_HIDDEN) return true;
  return false;
}

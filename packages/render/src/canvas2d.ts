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
import { packColor, strokeLine, type PixelRect } from './raster.ts';
import { applyScenePatch, LINK_SYMBOLS, type Scene, type ScenePatch } from './scene.ts';
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
const OVERVIEW_MARGIN = 0.2;

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
  /** The overview's pixels, kept between redraws of the same size. */
  private raster: ImageData | null = null;
  /**
   * The overview's link under each pixel (index + 1, 0 for none), for the cache as laid
   * out now: a change of colours only recolours pixels. False after anything that moves,
   * hides or re-sizes what is drawn.
   */
  private ids: Uint32Array | null = null;
  private idsValid = false;
  /** Scene rectangle that moved elements left or entered since the cache was drawn. */
  private dirty: Rect | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const ctx = canvas.getContext('2d') as Ctx | null;
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
    this.idsValid = false;
    this.highlight = null;
  }

  patchScene(p: ScenePatch): void {
    const s = this.scene;
    if (!s) return;
    // The area the moved elements covered before and cover now.
    const box: Rect = [Infinity, Infinity, -Infinity, -Infinity];
    const grow = (x: number, y: number) => {
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    };
    const cover = () => {
      p.nodes.forEach((i) => grow(s.nodeXY[2 * i]!, s.nodeXY[2 * i + 1]!));
      p.segs.forEach((q) => {
        grow(s.segXY[4 * q]!, s.segXY[4 * q + 1]!);
        grow(s.segXY[4 * q + 2]!, s.segXY[4 * q + 3]!);
      });
      p.syms.forEach((m) => grow(s.symXY[2 * m]!, s.symXY[2 * m + 1]!));
    };
    cover();
    applyScenePatch(s, p);
    cover();
    p.segs.forEach((q) => this.segGrid?.include(q));
    p.nodes.forEach((i) => this.nodeGrid?.include(i));
    // Too many moved items make every query slow: index the scene again.
    const moved = (this.segGrid?.moved ?? 0) + (this.nodeGrid?.moved ?? 0);
    if (moved > (s.segCount + s.nodeCount) / 16) {
      this.setScene(s);
      return;
    }
    if (Number.isFinite(box[0])) {
      const d = this.dirty;
      this.dirty = d
        ? [Math.min(d[0], box[0]), Math.min(d[1], box[1]), Math.max(d[2], box[2]), Math.max(d[3], box[3])]
        : box;
    }
    this.highlight = null;
  }

  setPaint(paint: Paint): void {
    this.paint = paint;
    this.cacheValid = false;
  }

  setFlags(node: Uint8Array, link: Uint8Array): void {
    // Hidden elements are part of the cached image; selection and hover are not.
    if (hiddenChanged(this.nodeFlags, node) || hiddenChanged(this.linkFlags, link)) {
      this.cacheValid = false;
      this.idsValid = false;
    }
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
    this.idsValid = false;
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

  /**
   * The links as pixels, into the whole cache or only `clip` (pixels) of it: which link
   * covers each pixel is rasterised when the layout or geometry changed, then every
   * pixel takes its link's colour. Where links cross, the later link in the scene is on
   * top (not the higher colour class, as with strokes; at this scale it is one pixel).
   * Returns false (drawing nothing) when a colour is not a plain hex colour.
   */
  private rasterNetwork(
    ctx: OffscreenCanvasRenderingContext2D,
    s: Scene,
    t: Theme,
    scale: number,
    dpr: number,
    rect: Rect,
    w: number,
    h: number,
    region: Rect | null,
    clip: PixelRect | null = null,
  ): boolean {
    const classes = this.paint?.linkClass;
    const colors = [t.link, ...(this.paint?.linkLegend?.colors ?? [])].map(packColor);
    const bg = t.background === 'transparent' ? 0 : packColor(t.background);
    if (bg === null || colors.some((c) => c === null)) return false;
    let img = this.raster;
    const fits = !!img && img.width === w && img.height === h && this.ids?.length === w * h;
    if (clip && !fits) return false;
    if (!img || !fits) {
      img = this.raster = ctx.createImageData(w, h);
      this.ids = new Uint32Array(w * h);
      this.idsValid = false;
    }
    const ids = this.ids!;
    const box: PixelRect = clip ?? [0, 0, w, h];
    if (clip || !this.idsValid) {
      if (clip) for (let y = box[1]; y < box[3]; y++) ids.fill(0, y * w + box[0], y * w + box[2]);
      else ids.fill(0);
      const k = scale * dpr;
      const xy = s.segXY;
      const lw = Math.max(1, Math.round(this.options.linkWidth * dpr));
      this.each(this.segGrid, s.segCount, region, (i) => {
        const li = s.segLink[i]!;
        if ((this.linkFlags[li] ?? 0) & FLAG_HIDDEN) return;
        strokeLine(
          ids,
          w,
          h,
          (xy[4 * i]! - rect[0]) * k,
          (rect[3] - xy[4 * i + 1]!) * k,
          (xy[4 * i + 2]! - rect[0]) * k,
          (rect[3] - xy[4 * i + 3]!) * k,
          lw,
          li + 1,
          box,
        );
      });
      if (!clip) this.idsValid = true;
    }
    // Colour every pixel by its link's class.
    const linkColor = new Uint32Array(s.linkCount + 1);
    linkColor[0] = bg;
    for (let li = 0; li < s.linkCount; li++) {
      const c = classes?.[li] ?? 0;
      linkColor[li + 1] = colors[c < colors.length ? c : 0]!;
    }
    const buf = new Uint32Array(img.data.buffer);
    for (let y = box[1]; y < box[3]; y++) {
      const end = y * w + box[2];
      for (let p = y * w + box[0]; p < end; p++) buf[p] = linkColor[ids[p]!]!;
    }
    if (clip) ctx.putImageData(img, 0, 0, box[0], box[1], box[2] - box[0], box[3] - box[1]);
    else ctx.putImageData(img, 0, 0);
    return true;
  }

  /** Draw again only the part of the cache that moved elements touched. */
  private redrawDirty(c: Cache, s: Scene, t: Theme): void {
    const d = this.dirty!;
    this.dirty = null;
    const pad = (this.options.linkWidth + this.options.nodeRadius + 1) / c.scale;
    const region: Rect = [d[0] - pad, d[1] - pad, d[2] + pad, d[3] + pad];
    const k = c.scale * c.dpr;
    const w = c.canvas.width;
    const h = c.canvas.height;
    const px: PixelRect = [
      Math.max(0, Math.floor((region[0] - c.rect[0]) * k)),
      Math.max(0, Math.floor((c.rect[3] - region[3]) * k)),
      Math.min(w, Math.ceil((region[2] - c.rect[0]) * k)),
      Math.min(h, Math.ceil((c.rect[3] - region[1]) * k)),
    ];
    if (px[0] >= px[2] || px[1] >= px[3]) return;
    const overview = s.typicalLength * c.scale < this.options.junctionMinSpacing;
    if (overview && this.rasterNetwork(c.ctx, s, t, c.scale, c.dpr, c.rect, w, h, region, px)) return;
    const ctx = c.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(px[0], px[1], px[2] - px[0], px[3] - px[1]);
    ctx.clip();
    if (t.background === 'transparent') ctx.clearRect(px[0], px[1], px[2] - px[0], px[3] - px[1]);
    else {
      ctx.fillStyle = t.background;
      ctx.fillRect(px[0], px[1], px[2] - px[0], px[3] - px[1]);
    }
    ctx.setTransform(k, 0, 0, -k, -c.rect[0] * k, c.rect[3] * k);
    // Everything that reaches into the area is drawn again, clipped to it.
    this.drawNetwork(ctx, s, t, c.scale, region);
    ctx.restore();
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
      if (this.dirty) this.redrawDirty(c, s, t);
      return c;
    }
    const overview = s.typicalLength * scale < this.options.junctionMinSpacing;
    // Only the colours changed, and the view is still inside the cache: keep its layout,
    // so the overview can recolour the pixels it has.
    const sameLayout =
      !!c &&
      !this.dirty &&
      c.scale === scale &&
      c.dpr === dpr &&
      vx - hw >= c.rect[0] &&
      vx + hw <= c.rect[2] &&
      vy - hh >= c.rect[1] &&
      vy + hh <= c.rect[3];
    if (!sameLayout) this.idsValid = false;
    this.dirty = null;
    // The overview redraws quickly, so it keeps a narrower margin (less to redraw when
    // colours change at each time step).
    const margin = overview ? OVERVIEW_MARGIN : MARGIN;
    const mx = hw * (1 + 2 * margin);
    const my = hh * (1 + 2 * margin);
    const rect: Rect = sameLayout ? c.rect : [vx - mx, vy - my, vx + mx, vy + my];
    const w = sameLayout ? c.canvas.width : Math.ceil(2 * mx * scale * dpr);
    const h = sameLayout ? c.canvas.height : Math.ceil(2 * my * scale * dpr);
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
    paintBackground(ctx, t.background, w, h);
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
    // Overview (links a few pixels long, junctions hidden): write the pixels directly.
    if (!overview || !this.rasterNetwork(ctx, s, t, scale, dpr, rect, w, h, region)) {
      this.drawNetwork(ctx, s, t, scale, region);
    }
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
    paintBackground(ctx, t?.background ?? '#ffffff', this.canvas.width, this.canvas.height);
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

function paintBackground(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  colour: string,
  w: number,
  h: number,
): void {
  if (colour === 'transparent') {
    ctx.clearRect(0, 0, w, h);
    return;
  }
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
}

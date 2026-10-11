/**
 * The Canvas 2D backend: the same scene as WebGPU, drawn into a 2D context (usually an
 * OffscreenCanvas in the render worker). Links are batched into one Path2D per colour
 * class, so draw calls scale with legend classes, not elements. Paths are built in
 * scene coordinates and drawn through the camera transform, so panning reuses them;
 * junction paths are rebuilt only when the zoom changes noticeably.
 */

import { atlasIndex, ATLAS_SYMBOLS, type Atlas } from './atlas.ts';
import type { Backend, Frame } from './backend.ts';
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

const NODE_ATLAS = [-1, atlasIndex('reservoir'), atlasIndex('tank')];
const LINK_ATLAS = LINK_SYMBOLS.map((s) => (s === 'none' ? -1 : ATLAS_SYMBOLS.indexOf(s)));

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
  private linkPaths: Path2D[] | null = null;
  private selectedLinks: Path2D | null = null;
  private hoverLinks: Path2D | null = null;
  private nodePaths: { scale: number; byClass: Path2D[]; selected: Path2D; hover: Path2D } | null = null;

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion -- the union differs by canvas type
    const ctx = canvas.getContext('2d', { alpha: false }) as Ctx | null;
    if (!ctx) throw new Error('Canvas 2D is not available');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  setScene(scene: Scene): void {
    this.scene = scene;
    this.invalidate();
  }

  setPaint(paint: Paint): void {
    this.paint = paint;
    this.invalidate();
  }

  setFlags(node: Uint8Array, link: Uint8Array): void {
    this.nodeFlags = node;
    this.linkFlags = link;
    this.invalidate();
  }

  setTheme(theme: Theme, atlas: Atlas | null): void {
    this.theme = theme;
    this.atlas = atlas;
  }

  setOptions(options: DrawOptions): void {
    this.options = options;
    this.nodePaths = null;
  }

  resize(width: number, height: number): void {
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
  }

  private invalidate(): void {
    this.linkPaths = null;
    this.nodePaths = null;
  }

  private buildLinkPaths(s: Scene): void {
    const classes = this.paint?.linkClass;
    const n = 1 + (this.paint?.linkLegend?.colors.length ?? 0);
    const paths = Array.from({ length: n }, () => new Path2D());
    const selected = new Path2D();
    const hover = new Path2D();
    const xy = s.segXY;
    for (let i = 0; i < s.segCount; i++) {
      const li = s.segLink[i]!;
      const f = this.linkFlags[li] ?? 0;
      if (f & FLAG_HIDDEN) continue;
      const p = paths[classes?.[li] ?? 0] ?? paths[0]!;
      const ax = xy[4 * i]!;
      const ay = xy[4 * i + 1]!;
      const bx = xy[4 * i + 2]!;
      const by = xy[4 * i + 3]!;
      p.moveTo(ax, ay);
      p.lineTo(bx, by);
      if (f & FLAG_SELECTED) {
        selected.moveTo(ax, ay);
        selected.lineTo(bx, by);
      }
      if (f & FLAG_HOVER) {
        hover.moveTo(ax, ay);
        hover.lineTo(bx, by);
      }
    }
    this.linkPaths = paths;
    this.selectedLinks = selected;
    this.hoverLinks = hover;
  }

  private buildNodePaths(s: Scene, scale: number): void {
    const classes = this.paint?.nodeClass;
    const n = 1 + (this.paint?.nodeLegend?.colors.length ?? 0);
    const byClass = Array.from({ length: n }, () => new Path2D());
    const selected = new Path2D();
    const hover = new Path2D();
    const r = this.options.nodeRadius / scale;
    const rs = (this.options.nodeRadius + 2.5) / scale;
    const xy = s.nodeXY;
    for (let i = 0; i < s.nodeCount; i++) {
      if (s.nodeKind[i] !== 0) continue;
      const f = this.nodeFlags[i] ?? 0;
      if (f & FLAG_HIDDEN) continue;
      const x = xy[2 * i]!;
      const y = xy[2 * i + 1]!;
      if (Number.isNaN(x)) continue;
      const p = byClass[classes?.[i] ?? 0] ?? byClass[0]!;
      p.moveTo(x + r, y);
      p.arc(x, y, r, 0, 2 * Math.PI);
      if (f & FLAG_SELECTED) {
        selected.moveTo(x + rs, y);
        selected.arc(x, y, rs, 0, 2 * Math.PI);
      }
      if (f & FLAG_HOVER) {
        hover.moveTo(x + rs, y);
        hover.arc(x, y, rs, 0, 2 * Math.PI);
      }
    }
    this.nodePaths = { scale, byClass, selected, hover };
  }

  render({ camera, dpr }: Frame): void {
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
    ctx.setTransform(scale * dpr, 0, 0, -scale * dpr, tx, ty);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (!this.linkPaths) this.buildLinkPaths(s);
    const linkColors = [t.link, ...(this.paint?.linkLegend?.colors ?? [])];
    const lw = this.options.linkWidth / scale;
    ctx.lineWidth = lw;
    this.linkPaths!.forEach((p, k) => {
      ctx.strokeStyle = linkColors[k] ?? t.link;
      ctx.stroke(p);
    });
    ctx.lineWidth = lw * 2.5;
    ctx.strokeStyle = t.selection;
    ctx.stroke(this.selectedLinks!);
    ctx.strokeStyle = t.hover;
    ctx.stroke(this.hoverLinks!);

    const spacing = s.typicalLength * scale;
    if (spacing >= this.options.junctionMinSpacing) {
      if (!this.nodePaths || Math.abs(Math.log(this.nodePaths.scale / scale)) > 0.05)
        this.buildNodePaths(s, scale);
      const np = this.nodePaths!;
      const nodeColors = [t.node, ...(this.paint?.nodeLegend?.colors ?? [])];
      np.byClass.forEach((p, k) => {
        ctx.fillStyle = nodeColors[k] ?? t.node;
        ctx.fill(p);
      });
      ctx.lineWidth = 2 / scale;
      ctx.strokeStyle = t.selection;
      ctx.stroke(np.selected);
      ctx.strokeStyle = t.hover;
      ctx.stroke(np.hover);
    }

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
    if (spacing >= this.options.symbolSize) {
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
    this.invalidate();
  }
}

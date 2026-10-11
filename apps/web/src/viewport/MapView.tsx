/**
 * The map: the network canvas (WebGPU or Canvas 2D, drawn in a worker), an overlay
 * canvas for rubber bands and tool previews, the legend, and every pointer interaction:
 * pan, zoom, select, move, and the drawing tools.
 */

import {
  addLink,
  addNode,
  EditError,
  moveNodes,
  setVertices,
  unitLabel,
  type Change,
  type LinkKind,
  type NodeKind,
} from '@waterstudio/core';
import {
  buildScene,
  FLAG_HIDDEN,
  FLAG_HOVER,
  FLAG_SELECTED,
  Renderer,
  themeFor,
  type Hit,
  type Legend,
  type Scene,
} from '@waterstudio/render';
import { useEffect, useRef, useState } from 'react';
import { useApp, useAppContext } from '../app/context.tsx';
import { Basemap, OSM_ATTRIBUTION } from '../geo/basemap.ts';
import { backdropPlacement, modelCrs, type ModelCrs } from '../geo/model.ts';
import type { AppState } from '../app/state.ts';
import { variableLabel } from '../shell/Ribbon.tsx';
import { computePaint, themeLegend, VARIABLE_QUANTITY } from './paint.ts';
import { drawAnnotations, LABEL_FONT, labelBoxes } from './annotations.ts';
import { mapSvg } from './svg.ts';
import { drawSizes } from '../app/prefs.ts';
import { autoLength, linkPoints } from '../app/geometry.ts';
import { newElement } from '../app/defaults.ts';

const GEOMETRY_FIELDS = new Set(['x', 'y', 'vertices', 'from', 'to', 'kind', 'pipeStatus', 'valveType']);
const DRAG_THRESHOLD = 4;

type Gesture =
  | { kind: 'none' }
  | { kind: 'pan'; x: number; y: number; id: number }
  | { kind: 'band'; x0: number; y0: number; x1: number; y1: number; add: boolean; id: number }
  | {
      kind: 'press';
      x: number;
      y: number;
      hit: Hit;
      add: boolean;
      id: number;
    }
  | { kind: 'move'; x0: number; y0: number; x1: number; y1: number; nodes: number[]; id: number }
  | { kind: 'link'; tool: LinkKind; from: number; points: number[] }
  | { kind: 'vertex'; link: number; index: number; x: number; y: number; id: number };

interface SceneIndex {
  scene: Scene;
  node: Map<number, number>;
  link: Map<number, number>;
}

function indexScene(scene: Scene): SceneIndex {
  const node = new Map<number, number>();
  const link = new Map<number, number>();
  scene.nodeHandles.forEach((h, i) => node.set(h, i));
  scene.linkHandles.forEach((h, i) => link.set(h, i));
  return { scene, node, link };
}

/** Wires a renderer to the app state; returns a cleanup function. */
class MapController {
  readonly renderer: Renderer;
  private index: SceneIndex | null = null;
  private sceneDirty = true;
  private paintDirty = true;
  private flagsDirty = true;
  private frame = 0;
  private unsubStore: () => void = () => {};
  private generation = -1;
  private lastSelection: Set<number> | null = null;
  private lastHover: number | null = null;
  private lastRun: unknown = null;
  private lastTheme: unknown = null;
  private lastPeriod = -1;
  gesture: Gesture = { kind: 'none' };
  overlay: HTMLCanvasElement | null = null;
  annotations: HTMLCanvasElement | null = null;
  private annotationFrame = 0;
  private lastMapOptions: unknown = null;
  cursor: [number, number] | null = null;
  private fitted = false;
  private readonly state: AppState;
  frames = 0;
  frameMs = 0;
  private readonly basemap: Basemap;
  private readonly backdrop: HTMLImageElement;
  private backdropUrl: string | null = null;
  private transparent = false;
  private crsKey = '';
  /** The coordinate system the basemap is shown in, or null when it is hidden. */
  shownCrs: ModelCrs | null = null;

  constructor(container: HTMLElement, state: AppState) {
    this.state = state;
    this.backdrop = document.createElement('img');
    this.backdrop.className = 'backdrop';
    this.backdrop.alt = '';
    this.backdrop.hidden = true;
    container.prepend(this.backdrop);
    this.basemap = new Basemap(container, (reason) => {
      state.log('warning', `The street map is unavailable here: ${reason}`);
      this.updateBasemap(true);
    });
    this.renderer = new Renderer(container, {
      onCamera: (cam) => {
        this.basemap.follow(cam);
        this.placeBackdrop();
        this.scheduleAnnotations();
        if (this.editableLink() !== null) this.drawOverlay();
      },
      prefer: state.prefs.renderer,
      onStatus: (s) => {
        state.renderer = s;
        if (s.note) state.log('info', s.note);
        if (s.error) state.log('error', `Renderer: ${s.error}`);
        state.emit();
      },
      onFrame: (ms) => {
        this.frames++;
        this.frameMs += ms;
      },
    });
    this.renderer.setOptions(drawSizes(state.prefs.map.size));
    this.lastMapOptions = state.prefs.map;
    this.updateBasemap(true);
    this.sync();
  }

  /** Show or hide the basemap for the model's coordinate system and the preference. */
  updateBasemap(force = false): void {
    const s = this.state;
    const key = `${s.generation}:${s.store.rev}:${s.prefs.basemap}:${s.prefs.resolvedTheme}:${s.backdrop?.url ?? ''}`;
    if (!force && key === this.crsKey) return;
    this.crsKey = key;
    const want = s.prefs.basemap === 'on' && !this.basemap.failure ? modelCrs(s.store.doc) : null;
    const changed = (want?.crs.code ?? null) !== (this.shownCrs?.crs.code ?? null);
    this.shownCrs = want;
    this.basemap.show(want?.crs ?? null);
    // The network is drawn on a transparent canvas whenever something shows beneath it.
    const transparent = want !== null || s.backdrop !== null;
    if (transparent !== this.transparent || force) {
      this.transparent = transparent;
      void this.renderer.setTheme(themeFor(s.prefs.resolvedTheme, transparent));
    }
    if (changed) {
      s.basemapShown = want !== null;
      s.emit();
    }
  }

  /** Position the backdrop image over its [BACKDROP] rectangle. */
  placeBackdrop(): void {
    const s = this.state;
    const img = this.backdrop;
    const url = s.backdrop?.url ?? null;
    if (url !== this.backdropUrl) {
      this.backdropUrl = url;
      if (url) img.src = url;
      else img.removeAttribute('src');
    }
    const at = url ? backdropPlacement(s.store.doc.data.backdrop) : null;
    img.hidden = !at;
    if (!at) return;
    const cam = this.renderer.camera;
    const [left, top] = cam.toScreen(Math.min(at.x1, at.x2), Math.max(at.y1, at.y2));
    const [right, bottom] = cam.toScreen(Math.max(at.x1, at.x2), Math.min(at.y1, at.y2));
    img.style.left = `${left}px`;
    img.style.top = `${top}px`;
    img.style.width = `${right - left}px`;
    img.style.height = `${bottom - top}px`;
  }

  /** Called on every app state change. */
  sync(): void {
    const s = this.state;
    this.updateBasemap();
    this.placeBackdrop();
    if (s.prefs.map !== this.lastMapOptions) {
      this.lastMapOptions = s.prefs.map;
      this.renderer.setOptions(drawSizes(s.prefs.map.size));
    }
    this.scheduleAnnotations();
    if (s.generation !== this.generation) {
      this.generation = s.generation;
      this.unsubStore();
      this.unsubStore = s.store.subscribe((c: Change) => this.onChange(c));
      this.sceneDirty = true;
      this.fitted = false;
    }
    if (s.selection !== this.lastSelection || s.hover !== this.lastHover) {
      if (s.selection !== this.lastSelection) requestAnimationFrame(() => this.drawOverlay());
      this.lastSelection = s.selection;
      this.lastHover = s.hover;
      this.flagsDirty = true;
    }
    if (s.run !== this.lastRun || s.mapTheme !== this.lastTheme || s.period !== this.lastPeriod) {
      this.lastRun = s.run;
      this.lastTheme = s.mapTheme;
      this.lastPeriod = s.period;
      this.paintDirty = true;
    }
    this.schedule();
  }

  private onChange(c: Change): void {
    if (c.structural || [...c.fields].some((f) => GEOMETRY_FIELDS.has(f))) this.sceneDirty = true;
    this.schedule();
    this.scheduleAnnotations();
  }

  scheduleAnnotations(): void {
    if (this.annotationFrame) return;
    this.annotationFrame = requestAnimationFrame(() => {
      this.annotationFrame = 0;
      this.drawAnnotations();
    });
  }

  /** Labels and flow arrows, on their own canvas under the overlay. */
  drawAnnotations(): void {
    const a = this.annotations;
    const ctx = a?.getContext('2d');
    if (!a || !ctx) return;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, a.width, a.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(a);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    drawAnnotations(ctx, this.renderer.camera, this.state, this.state.prefs.map, {
      label: v('--ws-color-canvas-label', '#5b6573'),
      text: v('--ws-color-text-primary', '#171c23'),
      halo: this.transparent ? v('--ws-color-bg-surface', '#ffffff') : v('--ws-color-canvas-bg', '#fbfcfd'),
      arrow: v('--ws-color-canvas-node', '#171c23'),
    });
  }

  /** The index of the map label under a screen point, if any. */
  labelAt(x: number, y: number): number {
    const ctx = this.annotations?.getContext('2d');
    if (!ctx) return -1;
    ctx.font = LABEL_FONT;
    const boxes = labelBoxes(
      this.state.store.doc.data.labels,
      this.renderer.camera,
      (t) => ctx.measureText(t).width,
    );
    return boxes.findIndex((b) => x >= b.x - 2 && x <= b.x + b.w && y >= b.y - 2 && y <= b.y + b.h);
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.flush();
    });
  }

  private flush(): void {
    const s = this.state;
    if (this.sceneDirty) {
      this.sceneDirty = false;
      const scene = buildScene(s.store.doc, s.store.rev);
      this.index = indexScene(scene);
      this.renderer.setScene(scene);
      if (!this.fitted) {
        this.fitted = true;
        this.renderer.fit();
      }
      this.flagsDirty = true;
      this.paintDirty = true;
    }
    const idx = this.index;
    if (!idx) return;
    if (this.paintDirty) {
      this.paintDirty = false;
      this.renderer.setPaint(computePaint(idx.scene, s.run, s.period, s.mapTheme));
    }
    if (this.flagsDirty) {
      this.flagsDirty = false;
      this.pushFlags();
    }
    this.renderer.redraw();
  }

  pushFlags(hidden: { nodes: Set<number>; links: Set<number> } | null = null): void {
    const idx = this.index;
    if (!idx) return;
    const nf = new Uint8Array(idx.scene.nodeCount);
    const lf = new Uint8Array(idx.scene.linkCount);
    const mark = (h: number, flag: number) => {
      const n = idx.node.get(h);
      if (n !== undefined) nf[n]! |= flag;
      const l = idx.link.get(h);
      if (l !== undefined) lf[l]! |= flag;
    };
    for (const h of this.state.selection) mark(h, FLAG_SELECTED);
    if (this.state.hover !== null) mark(this.state.hover, FLAG_HOVER);
    if (hidden) {
      for (const h of hidden.nodes) mark(h, FLAG_HIDDEN);
      for (const h of hidden.links) mark(h, FLAG_HIDDEN);
    }
    this.renderer.setFlags(nf, lf);
  }

  setTheme(): void {
    this.updateBasemap(true);
    this.drawOverlay();
  }

  fit(): void {
    this.renderer.fit();
    this.drawOverlay();
  }

  zoom(f: number): void {
    const c = this.renderer.camera;
    c.zoomAt(f, c.width / 2, c.height / 2);
    this.renderer.redraw();
    this.drawOverlay();
  }

  zoomTo(handles: number[]): void {
    const doc = this.state.store.doc;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const grow = (x: number, y: number) => {
      if (Number.isNaN(x) || Number.isNaN(y)) return;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    };
    for (const h of handles) {
      if (!doc.has(h)) continue;
      if (doc.isNode(h)) grow(doc.num(h, 'x'), doc.num(h, 'y'));
      else for (const n of [doc.num(h, 'from'), doc.num(h, 'to')]) grow(doc.num(n, 'x'), doc.num(n, 'y'));
    }
    if (!Number.isFinite(minX)) return;
    const pad = Math.max(maxX - minX, maxY - minY, this.index?.scene.typicalLength ?? 1) * 0.6;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.renderer.camera.fit({ minX: cx - pad, minY: cy - pad, maxX: cx + pad, maxY: cy + pad }, 32);
    this.renderer.redraw();
    this.drawOverlay();
  }

  resize(): void {
    this.renderer.resize();
    for (const o of [this.overlay, this.annotations]) {
      if (!o) continue;
      const dpr = devicePixelRatio || 1;
      const r = o.getBoundingClientRect();
      o.width = Math.max(1, Math.round(r.width * dpr));
      o.height = Math.max(1, Math.round(r.height * dpr));
    }
    this.drawOverlay();
    this.drawAnnotations();
  }

  pick(x: number, y: number): Hit | null {
    return this.renderer.pick(x, y, 7);
  }

  /** Overlay: rubber band, move preview and the link being drawn, in CSS pixels. */
  drawOverlay(): void {
    const o = this.overlay;
    const ctx = o?.getContext('2d');
    if (!o || !ctx) return;
    const dpr = devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, o.width, o.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(o);
    const sel = css.getPropertyValue('--ws-color-canvas-selection').trim() || '#e8590c';
    const accent = css.getPropertyValue('--ws-color-canvas-hover').trim() || '#2b7ff0';
    const cam = this.renderer.camera;
    const doc = this.state.store.doc;
    const g = this.gesture;
    if (g.kind === 'band') {
      const crossing = g.x1 < g.x0;
      ctx.strokeStyle = accent;
      ctx.fillStyle = crossing ? 'rgba(43,127,240,0.08)' : 'rgba(43,127,240,0.14)';
      ctx.setLineDash(crossing ? [5, 4] : []);
      const x = Math.min(g.x0, g.x1);
      const y = Math.min(g.y0, g.y1);
      ctx.fillRect(x, y, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(g.x1 - g.x0), Math.abs(g.y1 - g.y0));
      ctx.setLineDash([]);
    } else if (g.kind === 'move') {
      const dx = g.x1 - g.x0;
      const dy = g.y1 - g.y0;
      const moved = new Set(g.nodes);
      const at = (h: number): [number, number] => {
        const [sx, sy] = cam.toScreen(doc.num(h, 'x'), doc.num(h, 'y'));
        return moved.has(h) ? [sx + dx, sy + dy] : [sx, sy];
      };
      ctx.strokeStyle = sel;
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      for (const l of this.movingLinks(g.nodes)) {
        const a = at(doc.num(l, 'from'));
        const b = at(doc.num(l, 'to'));
        const v = doc.get(l, 'vertices') as number[];
        const both = moved.has(doc.num(l, 'from')) && moved.has(doc.num(l, 'to'));
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        for (let k = 0; k + 1 < v.length; k += 2) {
          const [sx, sy] = cam.toScreen(v[k]!, v[k + 1]!);
          ctx.lineTo(both ? sx + dx : sx, both ? sy + dy : sy);
        }
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
      ctx.fillStyle = sel;
      for (const h of g.nodes) {
        const [x, y] = at(h);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 2 * Math.PI);
        ctx.fill();
      }
    } else if (g.kind === 'vertex') {
      const v = [...(doc.get(g.link, 'vertices') as number[])];
      const [wx, wy] = cam.toWorld(g.x, g.y);
      v[2 * g.index] = wx;
      v[2 * g.index + 1] = wy;
      const a = doc.num(g.link, 'from');
      const b = doc.num(g.link, 'to');
      ctx.strokeStyle = sel;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(...cam.toScreen(doc.num(a, 'x'), doc.num(a, 'y')));
      for (let k = 0; k + 1 < v.length; k += 2) ctx.lineTo(...cam.toScreen(v[k]!, v[k + 1]!));
      ctx.lineTo(...cam.toScreen(doc.num(b, 'x'), doc.num(b, 'y')));
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (g.kind === 'link') {
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      const [fx, fy] = cam.toScreen(doc.num(g.from, 'x'), doc.num(g.from, 'y'));
      ctx.moveTo(fx, fy);
      for (let k = 0; k + 1 < g.points.length; k += 2) {
        const [sx, sy] = cam.toScreen(g.points[k]!, g.points[k + 1]!);
        ctx.lineTo(sx, sy);
      }
      if (this.cursor) ctx.lineTo(this.cursor[0], this.cursor[1]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = accent;
      ctx.beginPath();
      ctx.arc(fx, fy, 5, 0, 2 * Math.PI);
      ctx.fill();
    }
    const editable = this.editableLink();
    if (editable !== null && g.kind !== 'vertex') {
      ctx.fillStyle = css.getPropertyValue('--ws-color-bg-surface').trim() || '#fff';
      ctx.strokeStyle = sel;
      ctx.lineWidth = 1.5;
      for (const [vx, vy] of this.vertexHandles(editable)) {
        ctx.fillRect(vx - 4, vy - 4, 8, 8);
        ctx.strokeRect(vx - 4, vy - 4, 8, 8);
      }
    }
  }

  /** The link whose vertices can be edited: the only selected element, with the select tool. */
  editableLink(): number | null {
    const s = this.state;
    if (s.tool !== 'select' || s.selection.size !== 1) return null;
    const h = s.selection.values().next().value as number;
    return s.store.doc.has(h) && s.store.doc.isLink(h) ? h : null;
  }

  /** Screen positions of the editable link's vertices. */
  vertexHandles(link: number): [number, number][] {
    const v = this.state.store.doc.get(link, 'vertices') as number[];
    const cam = this.renderer.camera;
    const out: [number, number][] = [];
    for (let k = 0; k + 1 < v.length; k += 2) out.push(cam.toScreen(v[k]!, v[k + 1]!));
    return out;
  }

  /** The vertex of the editable link under a screen point, or -1. */
  vertexAt(x: number, y: number): number {
    const l = this.editableLink();
    if (l === null) return -1;
    return this.vertexHandles(l).findIndex(([vx, vy]) => Math.abs(vx - x) <= 6 && Math.abs(vy - y) <= 6);
  }

  movingLinks(nodes: number[]): Set<number> {
    const out = new Set<number>();
    for (const n of nodes) for (const l of this.state.store.doc.linksAt(n)) out.add(l);
    return out;
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.annotationFrame);
    this.unsubStore();
    this.renderer.destroy();
    this.basemap.destroy();
    this.backdrop.remove();
  }
}

function LegendBox({ title, legend, unit }: { title: string; legend: Legend; unit: string }) {
  const fmt = (v: number) =>
    Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toPrecision(2);
  const rows = legend.colors.map((c, k) => {
    const lo = legend.breaks[k - 1];
    const hi = legend.breaks[k];
    const label =
      lo === undefined ? `< ${fmt(hi ?? 0)}` : hi === undefined ? `≥ ${fmt(lo)}` : `${fmt(lo)} – ${fmt(hi)}`;
    return { c, label };
  });
  return (
    <div className="legend-box">
      <div className="legend-title">
        {title}
        {unit && <span className="unit"> ({unit})</span>}
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.label}>
            <span className="chip" style={{ background: r.c }} />
            {r.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Attribution() {
  const { state } = useApp();
  if (!state.basemapShown) return null;
  return (
    <div className="map-attribution">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
        {OSM_ATTRIBUTION}
      </a>
    </div>
  );
}

function Legends() {
  const { state } = useApp();
  const r = state.run;
  if (r.status !== 'done' || !r.results) return null;
  const results = r.results;
  const u = state.units;
  const unit = (v: string) => {
    const q = VARIABLE_QUANTITY[v as keyof typeof VARIABLE_QUANTITY];
    if (q === 'headloss') return u.si ? 'm/km' : 'ft/kft';
    return unitLabel(q, u);
  };
  const items: ['node' | 'link', string][] = [];
  if (state.mapTheme.node) items.push(['node', state.mapTheme.node]);
  if (state.mapTheme.link) items.push(['link', state.mapTheme.link]);
  return (
    <div className="legends" aria-label="Map legend">
      {state.stale && <div className="stale-badge">Results are out of date — run again</div>}
      {items.map(([table, v]) => {
        const legend = themeLegend(results, table, v, state.mapTheme);
        if (legend.breaks.length === 0) return null;
        return (
          <LegendBox
            key={table}
            title={`${table === 'node' ? 'Node' : 'Link'} ${variableLabel(v).toLowerCase()}`}
            legend={legend}
            unit={unit(v)}
          />
        );
      })}
    </div>
  );
}

/** The index of the polyline segment nearest a screen point. */
function nearestSegment(pts: [number, number][], x: number, y: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1]!;
    const [bx, by] = pts[i]!;
    const l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2));
    const d = Math.hypot(ax + t * (bx - ax) - x, ay + t * (by - ay) - y);
    if (d < bestD) {
      bestD = d;
      best = i - 1;
    }
  }
  return best;
}

const NODE_TOOLS = new Set(['junction', 'reservoir', 'tank']);
const LINK_TOOLS = new Set(['pipe', 'pump', 'valve']);

export function MapView() {
  const { state } = useAppContext();
  const host = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const annotations = useRef<HTMLCanvasElement>(null);
  const ctl = useRef<MapController | null>(null);
  const [rendererKey, setRendererKey] = useState(state.prefs.renderer);

  // Recreate the renderer when the preferred backend changes.
  useEffect(
    () =>
      state.prefs.subscribe(() => {
        if (state.prefs.renderer !== rendererKey) setRendererKey(state.prefs.renderer);
        else {
          ctl.current?.setTheme();
          ctl.current?.sync();
        }
      }),
    [state, rendererKey],
  );

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const c = new MapController(el, state);
    c.overlay = overlay.current;
    c.annotations = annotations.current;
    ctl.current = c;
    state.view = {
      fit: () => c.fit(),
      zoom: (f) => c.zoom(f),
      zoomTo: (h) => c.zoomTo(h),
      panBy: (dx, dy) => {
        c.renderer.camera.panBy(dx, dy);
        c.renderer.redraw();
      },
      frameStats: () => ({ frames: c.frames, ms: c.frameMs }),
      exportSvg: () => {
        const css = getComputedStyle(el);
        const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
        const cam = c.renderer.camera;
        const svg = mapSvg(state, cam, {
          background: v('--ws-color-canvas-bg', '#ffffff'),
          link: v('--ws-color-canvas-link', '#3d4653'),
          node: v('--ws-color-canvas-node', '#171c23'),
          text: v('--ws-color-text-primary', '#171c23'),
          surface: v('--ws-color-bg-surface', '#ffffff'),
          border: v('--ws-color-border-default', '#c9d0d9'),
        });
        return { svg, width: cam.width, height: cam.height };
      },
      screenOf: (h) => {
        const doc = state.store.doc;
        if (!doc.has(h) || !doc.isNode(h)) return null;
        return c.renderer.camera.toScreen(doc.num(h, 'x'), doc.num(h, 'y'));
      },
    };
    const unsub = state.subscribe(() => c.sync());
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el);
    c.resize();
    const media = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => c.setTheme();
    media.addEventListener('change', onScheme);
    return () => {
      media.removeEventListener('change', onScheme);
      ro.disconnect();
      unsub();
      state.view = null;
      c.destroy();
      ctl.current = null;
    };
  }, [state, rendererKey]);

  const local = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = overlay.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const onWheel = (e: React.WheelEvent) => {
    const c = ctl.current;
    if (!c) return;
    const [x, y] = local(e);
    c.renderer.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), x, y);
    c.renderer.redraw();
    c.drawOverlay();
  };

  const tryEdit = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      if (err instanceof EditError) state.log('warning', err.message);
      else throw err;
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const c = ctl.current;
    if (!c) return;
    const [x, y] = local(e);
    overlay.current?.focus();
    const add = e.shiftKey || e.ctrlKey || e.metaKey;
    if (e.button === 1 || state.tool === 'pan' || (e.button === 0 && e.altKey)) {
      c.gesture = { kind: 'pan', x, y, id: e.pointerId };
      overlay.current?.setPointerCapture(e.pointerId);
      return;
    }
    if (e.button === 2) {
      if (c.gesture.kind === 'link') {
        c.gesture = { kind: 'none' };
        c.drawOverlay();
      }
      return;
    }
    if (e.button !== 0) return;
    const cam = c.renderer.camera;
    const tool = state.tool;
    if (tool === 'label') {
      const labels = state.store.doc.data.labels;
      const i = c.labelAt(x, y);
      if (i >= 0) {
        const next = prompt('Label text (empty to delete):', labels[i]!.text);
        if (next === null) return;
        const t = next.trim();
        state.store.transact(t ? 'Edit label' : 'Delete label', (tx) =>
          tx.setDoc(
            'labels',
            t ? labels.map((l, j) => (j === i ? { ...l, text: t } : l)) : labels.filter((_, j) => j !== i),
          ),
        );
      } else {
        const t = prompt('Label text:')?.trim();
        if (!t) return;
        const [wx, wy] = cam.toWorld(x, y);
        state.store.transact('Add label', (tx) =>
          tx.setDoc('labels', [...labels, { x: wx, y: wy, text: t, anchor: null }]),
        );
      }
      return;
    }
    if (NODE_TOOLS.has(tool)) {
      const [wx, wy] = cam.toWorld(x, y);
      tryEdit(() => {
        const init = newElement(state, tool as NodeKind);
        const h = addNode(state.store, tool as NodeKind, { x: wx, y: wy, ...init });
        state.select([h]);
      });
      return;
    }
    if (LINK_TOOLS.has(tool)) {
      const doc0 = state.store.doc;
      const hit = c.pick(x, y);
      const g = c.gesture;
      if (g.kind !== 'link') {
        if (hit?.table === 'node')
          c.gesture = { kind: 'link', tool: tool as LinkKind, from: hit.handle, points: [] };
        else state.log('info', 'Start a link by clicking a node.');
      } else if (hit?.table === 'node' && hit.handle !== g.from) {
        tryEdit(() => {
          const values = autoLength(state, g.tool, [
            doc0.num(g.from, 'x'),
            doc0.num(g.from, 'y'),
            ...g.points,
            doc0.num(hit.handle, 'x'),
            doc0.num(hit.handle, 'y'),
          ]);
          const init = newElement(state, g.tool);
          const h = addLink(state.store, g.tool, {
            from: g.from,
            to: hit.handle,
            vertices: g.points,
            ...(init.id ? { id: init.id } : {}),
            values: { ...init.values, ...values },
          });
          state.select([h]);
        });
        c.gesture = { kind: 'none' };
      } else if (g.tool === 'pipe' && !hit) {
        const [wx, wy] = cam.toWorld(x, y);
        g.points.push(wx, wy);
      }
      c.drawOverlay();
      return;
    }
    // Select tool: a vertex handle of the selected link first.
    const vi = c.vertexAt(x, y);
    if (vi >= 0) {
      c.gesture = { kind: 'vertex', link: c.editableLink()!, index: vi, x, y, id: e.pointerId };
      overlay.current?.setPointerCapture(e.pointerId);
      return;
    }
    const hit = c.pick(x, y);
    if (hit) {
      c.gesture = { kind: 'press', x, y, hit, add, id: e.pointerId };
    } else {
      c.gesture = { kind: 'band', x0: x, y0: y, x1: x, y1: y, add, id: e.pointerId };
    }
    overlay.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const c = ctl.current;
    if (!c) return;
    const [x, y] = local(e);
    c.cursor = [x, y];
    const cam = c.renderer.camera;
    state.cursor = cam.toWorld(x, y);
    const g = c.gesture;
    switch (g.kind) {
      case 'pan':
        cam.panBy(x - g.x, y - g.y);
        g.x = x;
        g.y = y;
        c.renderer.redraw();
        c.drawOverlay();
        break;
      case 'band':
        g.x1 = x;
        g.y1 = y;
        c.drawOverlay();
        break;
      case 'press': {
        if (Math.hypot(x - g.x, y - g.y) < DRAG_THRESHOLD) break;
        const doc = state.store.doc;
        let nodes: number[];
        if (state.selection.has(g.hit.handle)) nodes = [...state.selection].filter((h) => doc.isNode(h));
        else if (g.hit.table === 'node') {
          nodes = [g.hit.handle];
          state.select(nodes);
        } else nodes = [];
        if (nodes.length === 0) {
          c.gesture = { kind: 'band', x0: g.x, y0: g.y, x1: x, y1: y, add: g.add, id: g.id };
        } else {
          c.gesture = { kind: 'move', x0: g.x, y0: g.y, x1: x, y1: y, nodes, id: g.id };
          c.pushFlags({ nodes: new Set(nodes), links: c.movingLinks(nodes) });
        }
        c.drawOverlay();
        break;
      }
      case 'move':
        g.x1 = x;
        g.y1 = y;
        c.drawOverlay();
        break;
      case 'link':
        c.drawOverlay();
        break;
      case 'vertex':
        g.x = x;
        g.y = y;
        c.drawOverlay();
        break;
      case 'none': {
        const hit = c.pick(x, y);
        state.setHover(hit?.handle ?? null);
        break;
      }
    }
    // The status bar shows the cursor position; it reads state on its own schedule.
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const c = ctl.current;
    if (!c) return;
    const g = c.gesture;
    if ('id' in g && g.id === e.pointerId) overlay.current?.releasePointerCapture(e.pointerId);
    if (g.kind === 'press') {
      state.select([g.hit.handle], g.add ? 'toggle' : 'replace');
      c.gesture = { kind: 'none' };
    } else if (g.kind === 'band') {
      c.gesture = { kind: 'none' };
      if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) < DRAG_THRESHOLD) {
        if (!g.add) state.select([]);
      } else {
        const q = c.renderer.queryScreenRect(g.x0, g.y0, g.x1, g.y1, g.x1 < g.x0);
        const scene = c.renderer.currentScene;
        if (scene) {
          const handles = [
            ...q.nodes.map((i) => scene.nodeHandles[i]!),
            ...q.links.map((i) => scene.linkHandles[i]!),
          ];
          state.select(handles, g.add ? 'add' : 'replace');
        }
      }
    } else if (g.kind === 'move') {
      c.gesture = { kind: 'none' };
      const cam = c.renderer.camera;
      const dx = (g.x1 - g.x0) / cam.scale;
      const dy = -(g.y1 - g.y0) / cam.scale;
      tryEdit(() => moveNodes(state.store, g.nodes, dx, dy, undefined, state.lengthOf));
      c.pushFlags();
    } else if (g.kind === 'pan') {
      c.gesture = { kind: 'none' };
    } else if (g.kind === 'vertex') {
      c.gesture = { kind: 'none' };
      const v = [...(state.store.doc.get(g.link, 'vertices') as number[])];
      const [wx, wy] = c.renderer.camera.toWorld(g.x, g.y);
      v[2 * g.index] = wx;
      v[2 * g.index + 1] = wy;
      tryEdit(() => setVertices(state.store, g.link, v, state.lengthOf));
    }
    c.drawOverlay();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const c = ctl.current;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [1, 0],
      ArrowRight: [-1, 0],
      ArrowUp: [0, 1],
      ArrowDown: [0, -1],
    };
    const dir = pan[e.key];
    if (c && dir && !e.altKey && !e.ctrlKey && !e.metaKey) {
      const step = e.shiftKey ? 320 : 80;
      c.renderer.camera.panBy(dir[0] * step, dir[1] * step);
      c.renderer.redraw();
      c.drawOverlay();
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape' && c && c.gesture.kind !== 'none') {
      const wasMove = c.gesture.kind === 'move';
      c.gesture = { kind: 'none' };
      if (wasMove) c.pushFlags();
      c.drawOverlay();
      e.stopPropagation();
    }
    if (e.key === 'Enter' && c?.gesture.kind === 'link') {
      c.gesture = { kind: 'none' };
      c.drawOverlay();
    }
  };

  const cursorClass =
    state.tool === 'pan' ? 'tool-pan' : state.tool === 'select' ? 'tool-select' : 'tool-draw';
  return (
    <div className="map-view">
      <div className="map-host" ref={host}>
        <canvas ref={annotations} className="map-annotations" aria-hidden="true" />
        <canvas
          ref={overlay}
          className={`map-overlay ${cursorClass}`}
          tabIndex={0}
          role="application"
          aria-label="Network map. Drag to select, wheel or = and - to zoom, arrow keys or middle-drag to pan. Add and select elements without a pointer from the model browser and the Add element panel."
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={() => state.setHover(null)}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          onDoubleClick={(e) => {
            const c = ctl.current;
            if (!c || c.gesture.kind === 'link') return;
            const [x, y] = local(e);
            const link = c.editableLink();
            if (link !== null) {
              // On the selected link: a vertex is removed, anywhere else on it one is added.
              const v = state.store.doc.get(link, 'vertices') as number[];
              const vi = c.vertexAt(x, y);
              if (vi >= 0) {
                tryEdit(() =>
                  setVertices(
                    state.store,
                    link,
                    [...v.slice(0, 2 * vi), ...v.slice(2 * vi + 2)],
                    state.lengthOf,
                  ),
                );
                return;
              }
              if (c.pick(x, y)?.handle === link) {
                const cam = c.renderer.camera;
                const pts = linkPoints(state.store.doc, link).reduce<[number, number][]>((a, n, i, arr) => {
                  if (i % 2 === 0) a.push(cam.toScreen(n, arr[i + 1]!));
                  return a;
                }, []);
                const seg = nearestSegment(pts, x, y);
                const [wx, wy] = cam.toWorld(x, y);
                tryEdit(() =>
                  setVertices(
                    state.store,
                    link,
                    [...v.slice(0, 2 * seg), wx, wy, ...v.slice(2 * seg)],
                    state.lengthOf,
                  ),
                );
                return;
              }
            }
            const hit = c.pick(x, y);
            if (hit) state.view?.zoomTo([hit.handle]);
          }}
        />
      </div>
      <Legends />
      <Attribution />
    </div>
  );
}

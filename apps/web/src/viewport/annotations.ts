/**
 * Map annotations drawn over the network on their own canvas: the model's map labels
 * ([LABELS]), element ID and value labels, and flow direction arrows, as EPANET's map
 * options offer them. Element labels appear only once they can be read: each label
 * claims its screen rectangle and a label that would overlap one already drawn is
 * skipped. Everything is in CSS pixels from the renderer's camera.
 */

import type { Document, model } from '@waterstudio/core';
import { linkFrame, nodeFrame } from '@waterstudio/engine-client';
import type { MapOptions } from '../app/prefs.ts';
import type { AppState } from '../app/state.ts';

export interface View {
  toScreen(x: number, y: number): [number, number];
  width: number;
  height: number;
}

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A coarse occupancy grid for label collision. */
class Occupancy {
  private readonly cells = new Map<number, Placed[]>();
  private readonly size = 48;

  claim(r: Placed): boolean {
    const s = this.size;
    const keys: number[] = [];
    for (let gx = Math.floor(r.x / s); gx <= Math.floor((r.x + r.w) / s); gx++)
      for (let gy = Math.floor(r.y / s); gy <= Math.floor((r.y + r.h) / s); gy++) keys.push(gx * 100003 + gy);
    for (const k of keys)
      for (const o of this.cells.get(k) ?? [])
        if (r.x < o.x + o.w && o.x < r.x + r.w && r.y < o.y + o.h && o.y < r.y + r.h) return false;
    for (const k of keys) {
      let l = this.cells.get(k);
      if (!l) this.cells.set(k, (l = []));
      l.push(r);
    }
    return true;
  }
}

function fmt(v: number, places: number): string {
  return Number.isFinite(v) ? v.toFixed(places) : '';
}

/** Screen boxes of the model's map labels, for picking them with the label tool. */
export function labelBoxes(
  labels: readonly model.Label[],
  view: View,
  measure: (text: string) => number,
): Placed[] {
  return labels.map((l) => {
    const [x, y] = view.toScreen(l.x, l.y);
    return { x, y, w: measure(l.text) + 4, h: 16 };
  });
}

export const LABEL_FONT = '12px system-ui, sans-serif';

export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  view: View,
  state: AppState,
  opts: MapOptions,
  colours: { label: string; text: string; halo: string; arrow: string },
): void {
  const doc = state.store.doc;
  const occ = new Occupancy();
  ctx.font = LABEL_FONT;
  ctx.textBaseline = 'top';
  ctx.lineJoin = 'round';
  const inView = (x: number, y: number, m = 40) =>
    x > -m && y > -m && x < view.width + m && y < view.height + m;
  const text = (s: string, x: number, y: number, colour: string) => {
    ctx.lineWidth = 3;
    ctx.strokeStyle = colours.halo;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = colour;
    ctx.fillText(s, x, y);
  };

  // The model's own labels are always drawn when shown.
  if (opts.mapLabels) {
    for (const l of doc.data.labels) {
      const [x, y] = view.toScreen(l.x, l.y);
      if (!inView(x, y, 400)) continue;
      const w = ctx.measureText(l.text).width;
      occ.claim({ x, y, w, h: 14 });
      text(l.text, x, y, colours.text);
    }
  }

  const r = state.run;
  const run = r.status === 'done' && r.results && r.nodes && r.links ? r : null;
  const nodeValues = new Map<number, number>();
  const linkValues = new Map<number, number>();
  if (run && opts.nodeValues && state.mapTheme.node) {
    const f = nodeFrame(run.results!, state.mapTheme.node, state.period);
    run.nodes!.forEach((h, i) => nodeValues.set(h, f[i]!));
  }
  const flows = new Map<number, number>();
  if (run && (opts.linkValues || opts.flowArrows)) {
    const v = state.mapTheme.link;
    const f = v && opts.linkValues ? linkFrame(run.results!, v, state.period) : null;
    const q = opts.flowArrows ? linkFrame(run.results!, 'flow', state.period) : null;
    run.links!.forEach((h, i) => {
      if (f) linkValues.set(h, f[i]!);
      if (q) flows.set(h, q[i]!);
    });
  }

  if (opts.flowArrows && flows.size > 0) drawArrows(ctx, view, doc, flows, colours.arrow);
  drawIsolationValves(ctx, view, doc, colours.arrow, colours.halo);

  const wantNodes = opts.nodeIds || nodeValues.size > 0;
  const wantLinks = opts.linkIds || linkValues.size > 0;
  // Too many elements in view and labels would only be noise.
  const budget = 3000;
  if (wantNodes) {
    let n = 0;
    for (const h of doc.nodeHandles()) {
      const [x, y] = view.toScreen(doc.num(h, 'x'), doc.num(h, 'y'));
      if (!inView(x, y, 0)) continue;
      if (++n > budget) break;
      const parts: string[] = [];
      if (opts.nodeIds) parts.push(doc.id(h));
      const v = nodeValues.get(h);
      if (v !== undefined) parts.push(fmt(v, state.prefs.places(state.mapTheme.node ?? '')));
      const s = parts.join('  ');
      if (!s) continue;
      const w = ctx.measureText(s).width;
      const box = { x: x + 6, y: y - 16, w, h: 14 };
      if (occ.claim(box)) text(s, box.x, box.y, colours.label);
    }
  }
  if (wantLinks) {
    let n = 0;
    for (const h of doc.linkHandles()) {
      const mid = midpoint(doc, h, view);
      if (!mid || !inView(mid[0], mid[1], 0)) continue;
      if (++n > budget) break;
      const parts: string[] = [];
      if (opts.linkIds) parts.push(doc.id(h));
      const v = linkValues.get(h);
      if (v !== undefined) parts.push(fmt(v, state.prefs.places(state.mapTheme.link ?? '')));
      const s = parts.join('  ');
      if (!s) continue;
      const w = ctx.measureText(s).width;
      const box = { x: mid[0] - w / 2, y: mid[1] + 4, w, h: 14 };
      if (occ.claim(box)) text(s, box.x, box.y, colours.label);
    }
  }
}

/** The screen midpoint of a link along its polyline, with the direction there. */
function midpoint(doc: Document, h: number, view: View): [number, number, number, number, number] | null {
  const a = doc.num(h, 'from');
  const b = doc.num(h, 'to');
  const v = doc.get(h, 'vertices') as number[];
  const pts: [number, number][] = [view.toScreen(doc.num(a, 'x'), doc.num(a, 'y'))];
  for (let k = 0; k + 1 < v.length; k += 2) pts.push(view.toScreen(v[k]!, v[k + 1]!));
  pts.push(view.toScreen(doc.num(b, 'x'), doc.num(b, 'y')));
  let total = 0;
  for (let i = 1; i < pts.length; i++)
    total += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  if (!Number.isFinite(total)) return null;
  let left = total / 2;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d >= left && d > 0) {
      const t = left / d;
      return [x0 + t * (x1 - x0), y0 + t * (y1 - y0), (x1 - x0) / d, (y1 - y0) / d, total];
    }
    left -= d;
  }
  const [x, y] = pts[0]!;
  return [x, y, 1, 0, total];
}

function drawArrows(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: Document,
  flows: Map<number, number>,
  colour: string,
): void {
  ctx.fillStyle = colour;
  let n = 0;
  for (const [h, q] of flows) {
    if (!doc.has(h) || Math.abs(q) < 1e-6) continue;
    const m = midpoint(doc, h, view);
    if (!m) continue;
    const [x, y, dx0, dy0, len] = m;
    if (len < 28 || x < 0 || y < 0 || x > view.width || y > view.height) continue;
    if (++n > 5000) break;
    const s = Math.sign(q);
    const dx = dx0 * s;
    const dy = dy0 * s;
    const size = 6;
    ctx.beginPath();
    ctx.moveTo(x + dx * size, y + dy * size);
    ctx.lineTo(x - dx * size - dy * size * 0.7, y - dy * size + dx * size * 0.7);
    ctx.lineTo(x - dx * size + dy * size * 0.7, y - dy * size - dx * size * 0.7);
    ctx.closePath();
    ctx.fill();
  }
}

/** Isolation valves as small bow ties on the pipe, a little way from the node they sit next to. */
function drawIsolationValves(
  ctx: CanvasRenderingContext2D,
  view: View,
  doc: Document,
  colour: string,
  fill: string,
): void {
  const valves = doc.data.isolationValves;
  if (valves.length === 0) return;
  ctx.strokeStyle = colour;
  ctx.fillStyle = fill;
  ctx.lineWidth = 1.5;
  let n = 0;
  for (const v of valves) {
    const l = doc.findLink(v.link);
    const at = doc.findNode(v.node);
    if (l === undefined || at === undefined) continue;
    const a = doc.num(l, 'from');
    const other = a === at ? doc.num(l, 'to') : a;
    const vs = doc.get(l, 'vertices') as number[];
    const toward: [number, number] =
      vs.length >= 2
        ? a === at
          ? [vs[0]!, vs[1]!]
          : [vs[vs.length - 2]!, vs[vs.length - 1]!]
        : [doc.num(other, 'x'), doc.num(other, 'y')];
    const [x0, y0] = view.toScreen(doc.num(at, 'x'), doc.num(at, 'y'));
    const [x1, y1] = view.toScreen(toward[0], toward[1]);
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d < 24 || x0 < -20 || y0 < -20 || x0 > view.width + 20 || y0 > view.height + 20) continue;
    if (++n > 5000) break;
    const ux = (x1 - x0) / d;
    const uy = (y1 - y0) / d;
    const cx = x0 + ux * Math.min(14, d / 3);
    const cy = y0 + uy * Math.min(14, d / 3);
    const s = 5;
    ctx.beginPath();
    ctx.moveTo(cx - ux * s - uy * s, cy - uy * s + ux * s);
    ctx.lineTo(cx + ux * s + uy * s, cy + uy * s - ux * s);
    ctx.lineTo(cx + ux * s - uy * s, cy + uy * s + ux * s);
    ctx.lineTo(cx - ux * s + uy * s, cy - uy * s - ux * s);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

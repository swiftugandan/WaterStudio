/**
 * The map as it is on screen, as a standalone SVG: links and nodes in their result
 * colours, pumps and valves as symbols, the model's map labels and the legends. For
 * reports, as EPANET's File › Export › Map; a PNG is rendered from the same SVG.
 */

import { buildScene, type Legend } from '@waterstudio/render';
import type { AppState } from '../app/state.ts';
import { variableLabel } from '../shell/Ribbon.tsx';
import { drawSizes } from '../app/prefs.ts';
import { computePaint, themeLegend, variableUnit } from './paint.ts';
import type { View } from './annotations.ts';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v: number) => (Math.round(v * 10) / 10).toString();

export interface SvgColours {
  background: string;
  link: string;
  node: string;
  text: string;
  surface: string;
  border: string;
}

export function mapSvg(state: AppState, view: View, colours: SvgColours): string {
  const doc = state.store.doc;
  const scene = buildScene(doc, state.store.rev);
  const paint = computePaint(scene, state.run, state.period, state.mapTheme);
  const nodeColour = new Map<number, string>();
  const linkColour = new Map<number, string>();
  scene.nodeHandles.forEach((h, i) => {
    const k = paint.nodeClass[i]!;
    if (k > 0 && paint.nodeLegend) nodeColour.set(h, paint.nodeLegend.colors[k - 1]!);
  });
  scene.linkHandles.forEach((h, i) => {
    const k = paint.linkClass[i]!;
    if (k > 0 && paint.linkLegend) linkColour.set(h, paint.linkLegend.colors[k - 1]!);
  });
  const size = drawSizes(state.prefs.map.size);
  const { width: W, height: H } = view;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(W)}" height="${n(H)}" viewBox="0 0 ${n(W)} ${n(H)}" font-family="system-ui, sans-serif" font-size="12">`,
    `<title>${esc(state.fileName)}</title>`,
    `<rect width="100%" height="100%" fill="${colours.background}"/>`,
  );
  const inView = (x: number, y: number) => x > -50 && y > -50 && x < W + 50 && y < H + 50;
  // Links.
  out.push(`<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="${size.linkWidth}">`);
  const symbols: string[] = [];
  for (const l of doc.linkHandles()) {
    const a = doc.num(l, 'from');
    const b = doc.num(l, 'to');
    const v = doc.get(l, 'vertices') as number[];
    const pts: [number, number][] = [view.toScreen(doc.num(a, 'x'), doc.num(a, 'y'))];
    for (let k = 0; k + 1 < v.length; k += 2) pts.push(view.toScreen(v[k]!, v[k + 1]!));
    pts.push(view.toScreen(doc.num(b, 'x'), doc.num(b, 'y')));
    if (!pts.some(([x, y]) => inView(x, y))) continue;
    const c = linkColour.get(l) ?? colours.link;
    out.push(`<polyline stroke="${c}" points="${pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ')}"/>`);
    const kind = doc.linkKind(l);
    if (kind !== 'pipe') {
      const [x0, y0] = pts[0]!;
      const [x1, y1] = pts[pts.length - 1]!;
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const ang = (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI;
      const s = size.symbolSize / 2.5;
      symbols.push(
        kind === 'pump'
          ? `<g transform="translate(${n(mx)} ${n(my)}) rotate(${n(ang)})"><circle r="${n(s)}" fill="${colours.surface}" stroke="${c}" stroke-width="1.5"/><path d="M${n(-s / 2)},${n(-s / 2)}L${n(s / 1.4)},0L${n(-s / 2)},${n(s / 2)}Z" fill="${c}"/></g>`
          : `<g transform="translate(${n(mx)} ${n(my)}) rotate(${n(ang)})"><path d="M${n(-s)},${n(-s / 1.6)}L${n(s)},${n(s / 1.6)}L${n(s)},${n(-s / 1.6)}L${n(-s)},${n(s / 1.6)}Z" fill="${colours.surface}" stroke="${c}" stroke-width="1.5"/></g>`,
      );
    }
  }
  out.push('</g>', ...symbols);
  // Nodes.
  const r = size.nodeRadius;
  const s = size.symbolSize / 2;
  for (const h of doc.nodeHandles()) {
    const [x, y] = view.toScreen(doc.num(h, 'x'), doc.num(h, 'y'));
    if (!inView(x, y)) continue;
    const c = nodeColour.get(h) ?? colours.node;
    const kind = doc.nodeKind(h);
    if (kind === 'junction') out.push(`<circle cx="${n(x)}" cy="${n(y)}" r="${r}" fill="${c}"/>`);
    else if (kind === 'reservoir')
      out.push(
        `<path d="M${n(x - s)},${n(y - s / 2)}L${n(x - s)},${n(y + s / 2)}L${n(x + s)},${n(y + s / 2)}L${n(x + s)},${n(y - s / 2)}" fill="${colours.surface}" stroke="${c}" stroke-width="1.5"/>`,
      );
    else
      out.push(
        `<rect x="${n(x - s / 1.6)}" y="${n(y - s)}" width="${n((2 * s) / 1.6)}" height="${n(2 * s)}" rx="2" fill="${colours.surface}" stroke="${c}" stroke-width="1.5"/>`,
      );
  }
  // Map labels.
  if (state.prefs.map.mapLabels) {
    for (const l of doc.data.labels) {
      const [x, y] = view.toScreen(l.x, l.y);
      if (inView(x, y))
        out.push(`<text x="${n(x)}" y="${n(y + 11)}" fill="${colours.text}">${esc(l.text)}</text>`);
    }
  }
  // Legends, as on the map.
  const run = state.run;
  if (run.status === 'done' && run.results) {
    let ly = H - 12;
    const items: [string, Legend, string][] = [];
    if (state.mapTheme.link) {
      const v = state.mapTheme.link;
      items.push([
        `Link ${variableLabel(v).toLowerCase()}`,
        themeLegend(run.results, 'link', v, state.mapTheme),
        variableUnit(v, state.units),
      ]);
    }
    if (state.mapTheme.node) {
      const v = state.mapTheme.node;
      items.push([
        `Node ${variableLabel(v).toLowerCase()}`,
        themeLegend(run.results, 'node', v, state.mapTheme),
        variableUnit(v, state.units),
      ]);
    }
    let lx = 12;
    for (const [title, legend, unit] of items) {
      if (legend.breaks.length === 0) continue;
      const h = 22 + 16 * legend.colors.length;
      const top = ly - h;
      out.push(`<g transform="translate(${lx} ${n(top)})">`);
      out.push(
        `<rect width="150" height="${h}" rx="4" fill="${colours.surface}" stroke="${colours.border}"/>`,
      );
      out.push(
        `<text x="8" y="16" font-weight="600" fill="${colours.text}">${esc(title)}${unit ? ` (${esc(unit)})` : ''}</text>`,
      );
      legend.colors.forEach((c, k) => {
        const lo = legend.breaks[k - 1];
        const hi = legend.breaks[k];
        const label = lo === undefined ? `< ${hi}` : hi === undefined ? `≥ ${lo}` : `${lo} – ${hi}`;
        out.push(`<rect x="8" y="${24 + 16 * k}" width="18" height="10" fill="${c}"/>`);
        out.push(`<text x="32" y="${33 + 16 * k}" fill="${colours.text}">${esc(label)}</text>`);
      });
      out.push('</g>');
      lx += 160;
      ly = H - 12;
    }
  }
  out.push('</svg>');
  return out.join('\n');
}

/** A PNG of an SVG at the device's pixel ratio. */
export async function svgToPng(svg: string, width: number, height: number, scale = 2): Promise<Blob> {
  const img = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('The map image could not be drawn.'));
      img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No 2D canvas is available.');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, width, height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The PNG could not be made.'))), 'image/png'),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

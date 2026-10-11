/**
 * DXF, for CAD. Export writes an R12 ASCII drawing every CAD program reads: links as
 * polylines on PIPES, PUMPS and VALVES layers, nodes as points on JUNCTIONS,
 * RESERVOIRS and TANKS layers, optional ID labels, and the map labels. Import reads
 * lines and polylines as pipes and points, circles and block inserts as nodes; layers
 * whose names mention reservoirs or tanks make those node types.
 */

import type { model } from '@waterstudio/core';
import { buildModel, type BuildOptions, type BuildResult, type RawLink, type RawNode } from './build.ts';

export interface DxfExportOptions {
  /** Write each element's ID as text beside it. */
  labels?: boolean;
  /** Text height in drawing units (defaults to 1/200 of the drawing's size). */
  textHeight?: number;
}

const LAYERS: [string, number][] = [
  ['PIPES', 5],
  ['PUMPS', 1],
  ['VALVES', 3],
  ['JUNCTIONS', 7],
  ['RESERVOIRS', 4],
  ['TANKS', 6],
  ['LABELS', 8],
];

function n(v: number): string {
  // Plenty of digits for survey coordinates, without exponent notation.
  return Number.isFinite(v) ? String(Math.round(v * 1e6) / 1e6) : '0';
}

/** The model as DXF text. */
export function modelToDxf(m: model.Model, opts: DxfExportOptions = {}): string {
  const out: string[] = [];
  const pair = (code: number, value: string | number) => out.push(String(code), String(value));
  const at = new Map<string, [number, number]>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of m.nodes) {
    if (!node.coordinates) continue;
    at.set(node.id, node.coordinates);
    const [x, y] = node.coordinates;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!Number.isFinite(minX)) [minX, minY, maxX, maxY] = [0, 0, 1, 1];
  const h = opts.textHeight ?? Math.max(maxX - minX, maxY - minY, 1) / 200;

  pair(0, 'SECTION');
  pair(2, 'HEADER');
  pair(9, '$ACADVER');
  pair(1, 'AC1009');
  pair(9, '$EXTMIN');
  pair(10, n(minX));
  pair(20, n(minY));
  pair(9, '$EXTMAX');
  pair(10, n(maxX));
  pair(20, n(maxY));
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'TABLES');
  pair(0, 'TABLE');
  pair(2, 'LAYER');
  pair(70, LAYERS.length);
  for (const [name, colour] of LAYERS) {
    pair(0, 'LAYER');
    pair(2, name);
    pair(70, 0);
    pair(62, colour);
    pair(6, 'CONTINUOUS');
  }
  pair(0, 'ENDTAB');
  pair(0, 'ENDSEC');

  pair(0, 'SECTION');
  pair(2, 'ENTITIES');
  const text = (x: number, y: number, s: string, layer = 'LABELS') => {
    pair(0, 'TEXT');
    pair(8, layer);
    pair(10, n(x));
    pair(20, n(y));
    pair(40, n(h));
    pair(1, s);
  };
  for (const l of m.links) {
    const a = at.get(l.from);
    const b = at.get(l.to);
    if (!a || !b) continue;
    const layer = l.kind.type === 'pipe' ? 'PIPES' : l.kind.type === 'pump' ? 'PUMPS' : 'VALVES';
    const pts = [a, ...l.vertices, b];
    pair(0, 'POLYLINE');
    pair(8, layer);
    pair(66, 1);
    pair(10, 0);
    pair(20, 0);
    for (const [x, y] of pts) {
      pair(0, 'VERTEX');
      pair(8, layer);
      pair(10, n(x));
      pair(20, n(y));
    }
    pair(0, 'SEQEND');
    pair(8, layer);
    if (opts.labels) {
      const mid = pts[Math.floor((pts.length - 1) / 2)]!;
      const next = pts[Math.floor((pts.length - 1) / 2) + 1]!;
      text((mid[0] + next[0]) / 2, (mid[1] + next[1]) / 2, l.id);
    }
  }
  for (const node of m.nodes) {
    if (!node.coordinates) continue;
    const [x, y] = node.coordinates;
    const layer =
      node.kind.type === 'junction' ? 'JUNCTIONS' : node.kind.type === 'reservoir' ? 'RESERVOIRS' : 'TANKS';
    pair(0, 'POINT');
    pair(8, layer);
    pair(10, n(x));
    pair(20, n(y));
    const z = node.kind.type === 'reservoir' ? node.kind.head : node.kind.elevation;
    pair(30, n(z));
    if (opts.labels) text(x + h, y + h, node.id);
  }
  for (const lab of m.labels) text(lab.x, lab.y, lab.text);
  pair(0, 'ENDSEC');
  pair(0, 'EOF');
  return `${out.join('\n')}\n`;
}

interface Entity {
  type: string;
  codes: [number, string][];
}

/** Group-code pairs of the ENTITIES section, gathered into entities. */
function entities(text: string): Entity[] {
  const lines = text.split(/\r?\n/);
  const out: Entity[] = [];
  let inEntities = false;
  let cur: Entity | null = null;
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i]!.trim());
    const value = lines[i + 1]!.trim();
    if (!Number.isFinite(code)) continue;
    if (code === 0) {
      if (cur && inEntities) out.push(cur);
      cur = null;
      if (value === 'ENDSEC') inEntities = false;
      else if (inEntities) cur = { type: value, codes: [] };
      continue;
    }
    if (code === 2 && value === 'ENTITIES' && !cur) {
      inEntities = true;
      continue;
    }
    cur?.codes.push([code, value]);
  }
  return out;
}

function first(e: Entity, code: number): string | undefined {
  return e.codes.find(([c]) => c === code)?.[1];
}

function nums(e: Entity, code: number): number[] {
  return e.codes.filter(([c]) => c === code).map(([, v]) => Number(v));
}

function nodeType(layer: string): string {
  const u = layer.toUpperCase();
  return u.includes('RESERV') ? 'reservoir' : u.includes('TANK') ? 'tank' : 'junction';
}

/** Build a network from a DXF drawing's lines and points. */
export function dxfToModel(text: string, opts: BuildOptions): BuildResult {
  const nodes: RawNode[] = [];
  const links: RawLink[] = [];
  const ents = entities(text);
  let ignored = 0;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i]!;
    const layer = first(e, 8) ?? '0';
    switch (e.type) {
      case 'LINE': {
        const [x1, y1, x2, y2] = [first(e, 10), first(e, 20), first(e, 11), first(e, 21)].map(Number);
        links.push({
          points: [
            [x1!, y1!],
            [x2!, y2!],
          ],
          props: { layer },
        });
        break;
      }
      case 'LWPOLYLINE': {
        const xs = nums(e, 10);
        const ys = nums(e, 20);
        links.push({ points: xs.map((x, k) => [x, ys[k] ?? NaN]), props: { layer } });
        break;
      }
      case 'POLYLINE': {
        const pts: [number, number][] = [];
        while (ents[i + 1]?.type === 'VERTEX') {
          i++;
          pts.push([Number(first(ents[i]!, 10)), Number(first(ents[i]!, 20))]);
        }
        if (ents[i + 1]?.type === 'SEQEND') i++;
        links.push({ points: pts, props: { layer } });
        break;
      }
      case 'POINT':
      case 'CIRCLE':
      case 'INSERT': {
        const z = Number(first(e, 30));
        const n: RawNode = {
          x: Number(first(e, 10)),
          y: Number(first(e, 20)),
          props: { type: nodeType(layer) },
        };
        if (Number.isFinite(z) && z !== 0) n.z = z;
        nodes.push(n);
        break;
      }
      default:
        ignored++;
    }
  }
  const r = buildModel(nodes, links, opts);
  const issues = [...r.issues];
  if (ignored > 0) issues.unshift(`${ignored} drawing entities that are not lines or points were ignored.`);
  return { model: r.model, issues };
}

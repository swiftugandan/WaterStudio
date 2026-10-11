/**
 * Building a network from geometry, the common half of every import: points become
 * nodes, lines become pipes, and line ends snap to the nearest node within a
 * tolerance or get a new junction. Attributes are read by common names, any case.
 */

import type { model } from '@waterstudio/core';

export type Props = Record<string, unknown>;

export interface RawNode {
  x: number;
  y: number;
  z?: number;
  props: Props;
}

export interface RawLink {
  points: [number, number][];
  props: Props;
}

export interface BuildOptions {
  /** Distance within which a line end joins a node, in model units. */
  snap: number;
  /** Flow units for the new model (SI units take lengths in metres, diameters in mm). */
  units: 'LPS' | 'GPM';
  /** Prefix for generated IDs. */
  prefixes?: { junction?: string; pipe?: string };
}

export interface BuildResult {
  model: model.Model;
  issues: string[];
}

/** The first property present under any of `names` (case-insensitive). */
export function prop(p: Props, ...names: string[]): unknown {
  const keys = Object.keys(p);
  for (const n of names) {
    const k = keys.find((key) => key.toLowerCase() === n.toLowerCase());
    if (k !== undefined && p[k] !== null && p[k] !== undefined && p[k] !== '') return p[k];
  }
  return undefined;
}

export function num(p: Props, ...names: string[]): number | undefined {
  const v = prop(p, ...names);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export function str(p: Props, ...names: string[]): string | undefined {
  const v = prop(p, ...names);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function section(lines: string[][] = []): model.KeywordSection {
  return { lines: lines.map((tokens) => ({ tokens, comment: null })) };
}

export function emptyModel(units: 'LPS' | 'GPM'): model.Model {
  return {
    title: [],
    nodes: [],
    links: [],
    patterns: [],
    curves: [],
    controls: [],
    rules: [],
    options: section([
      ['Units', units],
      ['Headloss', 'H-W'],
    ]),
    times: section([['Duration', '0']]),
    report: section(),
    energy: section(),
    reactions: section(),
    backdrop: section(),
    labels: [],
    extraSections: [],
  };
}

/** EPANET IDs: at most 31 characters, no spaces, semicolons or quotes. */
function cleanId(s: string): string {
  return s
    .trim()
    .replace(/[\s;"]+/g, '_')
    .slice(0, 31);
}

class Ids {
  private readonly used = new Set<string>();
  private readonly counter = new Map<string, number>();

  take(wanted: string | undefined, prefix: string): string {
    const clean = wanted !== undefined ? cleanId(wanted) : '';
    if (clean && !this.used.has(clean)) {
      this.used.add(clean);
      return clean;
    }
    const base = clean ? `${clean.slice(0, 27)}_` : prefix;
    let n = this.counter.get(base) ?? (clean ? 2 : 1);
    let id = `${base}${n++}`;
    while (this.used.has(id)) id = `${base}${n++}`;
    this.counter.set(base, n);
    this.used.add(id);
    return id;
  }
}

/** A uniform grid of node positions for snapping. */
class SnapGrid {
  private readonly cells = new Map<string, { x: number; y: number; id: string }[]>();
  private readonly size: number;
  constructor(size: number) {
    this.size = size;
  }
  private key(x: number, y: number): string {
    return `${Math.floor(x / this.size)},${Math.floor(y / this.size)}`;
  }
  add(x: number, y: number, id: string): void {
    const k = this.key(x, y);
    let c = this.cells.get(k);
    if (!c) this.cells.set(k, (c = []));
    c.push({ x, y, id });
  }
  nearest(x: number, y: number, within: number): string | undefined {
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    let best: string | undefined;
    let bd = within;
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        for (const p of this.cells.get(`${i},${j}`) ?? []) {
          const d = Math.hypot(p.x - x, p.y - y);
          if (d <= bd) {
            bd = d;
            best = p.id;
          }
        }
      }
    }
    return best;
  }
}

function nodeKind(p: Props, z: number | undefined, si: boolean): model.NodeKind {
  const type = (str(p, 'type', 'kind', 'node_type', 'nodetype') ?? 'junction').toLowerCase();
  const elevation = num(p, 'elevation', 'elev', 'z', 'ground', 'altitude') ?? z ?? 0;
  if (type.startsWith('res')) {
    return {
      type: 'reservoir',
      head: num(p, 'head', 'total_head') ?? elevation,
      pattern: str(p, 'pattern') ?? null,
      level: 0,
    };
  }
  if (type.startsWith('tank')) {
    const maxLevel = num(p, 'max_level', 'maxlevel') ?? (si ? 5 : 16);
    return {
      type: 'tank',
      elevation,
      initLevel: num(p, 'init_level', 'initlevel', 'level') ?? maxLevel / 2,
      minLevel: num(p, 'min_level', 'minlevel') ?? 0,
      maxLevel,
      diameter: num(p, 'diameter', 'diam') ?? (si ? 15 : 50),
      minVolume: num(p, 'min_volume', 'minvol') ?? 0,
      volumeCurve: null,
      overflow: null,
      mixing: null,
      bulkCoeff: null,
    };
  }
  const base = num(p, 'demand', 'base_demand', 'basedemand', 'consumption');
  return {
    type: 'junction',
    elevation,
    demands: [{ base: base ?? 0, pattern: str(p, 'pattern') ?? null, category: null }],
    emitter: num(p, 'emitter') ?? null,
  };
}

function lineLength(points: [number, number][]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) {
    l += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  }
  return l;
}

function pipeStatus(p: Props): model.PipeStatus {
  const s = (str(p, 'status') ?? '').toLowerCase();
  return s.startsWith('cl') ? 'closed' : s === 'cv' || s.startsWith('check') ? 'checkValve' : 'open';
}

export function buildModel(rawNodes: RawNode[], rawLinks: RawLink[], opts: BuildOptions): BuildResult {
  const si = opts.units === 'LPS';
  const m = emptyModel(opts.units);
  const issues: string[] = [];
  const nodeIds = new Ids();
  const linkIds = new Ids();
  const grid = new SnapGrid(Math.max(opts.snap, 1e-9));
  const byId = new Map<string, model.Node>();

  const addNode = (x: number, y: number, z: number | undefined, p: Props, wanted?: string): string => {
    const id = nodeIds.take(
      wanted ?? str(p, 'id', 'name', 'node_id', 'label'),
      opts.prefixes?.junction ?? 'J',
    );
    const n: model.Node = {
      id,
      kind: nodeKind(p, z, si),
      comment: str(p, 'description', 'comment') ?? null,
      tag: str(p, 'tag') ?? null,
      coordinates: [x, y],
      initialQuality: num(p, 'initial_quality', 'quality') ?? null,
      source: null,
    };
    m.nodes.push(n);
    byId.set(id, n);
    grid.add(x, y, id);
    return id;
  };

  for (const n of rawNodes) {
    if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) {
      issues.push('A point without coordinates was skipped.');
      continue;
    }
    addNode(n.x, n.y, n.z, n.props);
  }

  let created = 0;
  const endNode = (pt: [number, number], named: string | undefined): string => {
    if (named !== undefined && byId.has(cleanId(named))) return cleanId(named);
    const near = grid.nearest(pt[0], pt[1], opts.snap);
    if (near !== undefined) return near;
    created++;
    return addNode(pt[0], pt[1], undefined, {});
  };

  for (const l of rawLinks) {
    const pts = l.points.filter((q) => Number.isFinite(q[0]) && Number.isFinite(q[1]));
    if (pts.length < 2) {
      issues.push('A line with fewer than two points was skipped.');
      continue;
    }
    const p = l.props;
    const from = endNode(pts[0]!, str(p, 'from', 'from_node', 'node1', 'start_node'));
    const to = endNode(pts[pts.length - 1]!, str(p, 'to', 'to_node', 'node2', 'end_node'));
    if (from === to) {
      issues.push(`A line starting and ending at node ${from} was skipped.`);
      continue;
    }
    const id = linkIds.take(str(p, 'id', 'name', 'link_id', 'label'), opts.prefixes?.pipe ?? 'P');
    const type = (str(p, 'type', 'kind', 'link_type') ?? 'pipe').toLowerCase();
    const diameter = num(p, 'diameter', 'diam', 'dn', 'size') ?? (si ? 150 : 6);
    const minorLoss = num(p, 'minor_loss', 'minorloss', 'mloss') ?? 0;
    let kind: model.LinkKind;
    const valveType = (str(p, 'valve_type', 'valvetype') ?? type).toUpperCase();
    if (['PRV', 'PSV', 'PBV', 'FCV', 'TCV', 'GPV'].includes(valveType)) {
      kind = {
        type: 'valve',
        valveType: valveType.toLowerCase() as model.ValveType,
        diameter,
        setting: { type: 'value', value: num(p, 'setting') ?? 0 },
        minorLoss,
        pcvCurve: null,
        fixedStatus: null,
      };
    } else {
      if (type.startsWith('pump') || type.startsWith('valve')) {
        issues.push(`${id} is a ${type} without the data EPANET needs; it was imported as a pipe.`);
      }
      const given = num(p, 'length', 'len', 'shape_length');
      kind = {
        type: 'pipe',
        length: given !== undefined && given > 0 ? given : Math.max(lineLength(pts), 0.01),
        diameter,
        roughness: num(p, 'roughness', 'rough', 'c', 'hw_c', 'chw') ?? 130,
        minorLoss,
        status: pipeStatus(p),
        leakage: null,
        bulkCoeff: null,
        wallCoeff: null,
      };
    }
    m.links.push({
      id,
      from,
      to,
      kind,
      comment: str(p, 'description', 'comment') ?? null,
      tag: str(p, 'tag') ?? null,
      vertices: pts.slice(1, -1),
    });
  }
  if (created > 0) issues.push(`${created} junctions were created where lines met no point.`);
  if (!m.nodes.some((n) => n.kind.type !== 'junction')) {
    issues.push('The network has no reservoir or tank; add one before running it.');
  }
  return { model: m, issues };
}

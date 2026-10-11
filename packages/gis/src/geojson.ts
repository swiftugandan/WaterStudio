/**
 * GeoJSON (RFC 7946). Export writes nodes as points and links as lines with their
 * attributes; coordinates are converted to longitude and latitude when the model has
 * a coordinate system, as the standard requires, and left as they are (with a note)
 * when it has none. Import turns points and lines into a network (see build.ts).
 */

import type { model } from '@waterstudio/core';
import {
  buildModel,
  str,
  type BuildOptions,
  type BuildResult,
  type Props,
  type RawLink,
  type RawNode,
} from './build.ts';

export interface Projector {
  toLngLat(x: number, y: number): [number, number];
  fromLngLat(lng: number, lat: number): [number, number];
}

type Position = number[];
type Geometry =
  | { type: 'Point'; coordinates: Position }
  | { type: 'MultiPoint'; coordinates: Position[] }
  | { type: 'LineString'; coordinates: Position[] }
  | { type: 'MultiLineString'; coordinates: Position[][] }
  | { type: 'Polygon' | 'MultiPolygon' | 'GeometryCollection'; coordinates?: unknown };

export interface Feature {
  type: 'Feature';
  id?: string | number;
  geometry: Geometry | null;
  properties: Props | null;
}

export interface FeatureCollection {
  type: 'FeatureCollection';
  features: Feature[];
  [k: string]: unknown;
}

export interface ExportOptions {
  /** The model's coordinate system; without it coordinates are written as they are. */
  project?: Projector | undefined;
  /** Extra attributes per element (results, say), by element ID. */
  extra?: (table: 'node' | 'link', id: string) => Props | undefined;
}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

function nodeProps(n: model.Node): Props {
  const k = n.kind;
  const p: Props = { id: n.id, type: k.type };
  if (k.type === 'junction') {
    p['elevation'] = k.elevation;
    p['demand'] = k.demands.reduce((a, d) => a + d.base, 0);
    const pat = k.demands.find((d) => d.pattern)?.pattern;
    if (pat) p['pattern'] = pat;
    if (k.emitter !== null) p['emitter'] = k.emitter;
  } else if (k.type === 'reservoir') {
    p['head'] = k.head;
    if (k.pattern) p['pattern'] = k.pattern;
  } else {
    Object.assign(p, {
      elevation: k.elevation,
      init_level: k.initLevel,
      min_level: k.minLevel,
      max_level: k.maxLevel,
      diameter: k.diameter,
      min_volume: k.minVolume,
    });
    if (k.volumeCurve) p['volume_curve'] = k.volumeCurve;
  }
  if (n.initialQuality !== null) p['initial_quality'] = n.initialQuality;
  if (n.tag) p['tag'] = n.tag;
  if (n.comment) p['description'] = n.comment;
  return p;
}

function linkProps(l: model.Link): Props {
  const k = l.kind;
  const p: Props = { id: l.id, type: k.type, from: l.from, to: l.to };
  if (k.type === 'pipe') {
    Object.assign(p, {
      length: k.length,
      diameter: k.diameter,
      roughness: k.roughness,
      minor_loss: k.minorLoss,
      status: k.status === 'checkValve' ? 'CV' : k.status.toUpperCase(),
    });
  } else if (k.type === 'pump') {
    if (k.curve?.type === 'head') p['head_curve'] = k.curve.value;
    if (k.curve?.type === 'power') p['power'] = k.curve.value;
    p['speed'] = k.speed;
    p['status'] = k.status.toUpperCase();
  } else {
    Object.assign(p, {
      valve_type: k.valveType.toUpperCase(),
      diameter: k.diameter,
      setting: k.setting.value,
      minor_loss: k.minorLoss,
    });
  }
  if (l.tag) p['tag'] = l.tag;
  if (l.comment) p['description'] = l.comment;
  return p;
}

/** The model as a FeatureCollection. */
export function modelToGeoJSON(m: model.Model, opts: ExportOptions = {}): FeatureCollection {
  const at = new Map<string, [number, number]>();
  for (const n of m.nodes) if (n.coordinates) at.set(n.id, n.coordinates);
  const pos = (x: number, y: number): Position => {
    if (!opts.project) return [x, y];
    const [lng, lat] = opts.project.toLngLat(x, y);
    return [round(lng, 8), round(lat, 8)];
  };
  const features: Feature[] = [];
  for (const n of m.nodes) {
    features.push({
      type: 'Feature',
      id: `node:${n.id}`,
      geometry: n.coordinates
        ? { type: 'Point', coordinates: pos(n.coordinates[0], n.coordinates[1]) }
        : null,
      properties: { ...nodeProps(n), ...opts.extra?.('node', n.id) },
    });
  }
  for (const l of m.links) {
    const a = at.get(l.from);
    const b = at.get(l.to);
    const coords = a && b ? [a, ...l.vertices, b].map(([x, y]) => pos(x, y)) : null;
    features.push({
      type: 'Feature',
      id: `link:${l.id}`,
      geometry: coords ? { type: 'LineString', coordinates: coords } : null,
      properties: { ...linkProps(l), ...opts.extra?.('link', l.id) },
    });
  }
  const fc: FeatureCollection = { type: 'FeatureCollection', features };
  if (!opts.project) {
    fc['waterstudio'] = { note: 'Coordinates are the model’s own: the model has no coordinate system.' };
  }
  return fc;
}

export interface ImportOptions extends BuildOptions {
  /**
   * Turn longitude and latitude into model coordinates. Without it coordinates are
   * taken as they are.
   */
  project?: Projector | undefined;
}

function features(input: unknown): Feature[] {
  if (!input || typeof input !== 'object') return [];
  const o = input as { type?: string; features?: unknown; geometry?: unknown };
  if (o.type === 'FeatureCollection' && Array.isArray(o.features)) return o.features as Feature[];
  if (o.type === 'Feature') return [o as Feature];
  if (typeof o.type === 'string' && 'coordinates' in o) {
    return [{ type: 'Feature', geometry: o as Geometry, properties: {} }];
  }
  return [];
}

/** Build a network from GeoJSON points and lines. */
export function geoJSONToModel(input: unknown, opts: ImportOptions): BuildResult {
  const nodes: RawNode[] = [];
  const links: RawLink[] = [];
  const issues: string[] = [];
  const xy = (p: Position): [number, number] => {
    const [a = NaN, b = NaN] = p;
    return opts.project ? opts.project.fromLngLat(a, b) : [a, b];
  };
  let skipped = 0;
  for (const f of features(input)) {
    const props: Props = { ...(f.properties ?? {}) };
    if (f.id !== undefined && props['id'] === undefined)
      props['id'] = String(f.id).replace(/^(node|link):/, '');
    const g = f.geometry;
    if (!g) {
      skipped++;
      continue;
    }
    if (g.type === 'Point' || g.type === 'MultiPoint') {
      const p = g.type === 'Point' ? g.coordinates : g.coordinates[0];
      if (!p) continue;
      const [x, y] = xy(p);
      const n: RawNode = { x, y, props };
      if (p[2] !== undefined && Number.isFinite(p[2])) n.z = p[2];
      nodes.push(n);
    } else if (g.type === 'LineString') {
      links.push({ points: g.coordinates.map(xy), props });
    } else if (g.type === 'MultiLineString') {
      // A multi-line becomes one link per part; parts after the first get suffixed IDs.
      g.coordinates.forEach((part, i) => {
        const pp = { ...props };
        const id = str(pp, 'id', 'name', 'link_id', 'label');
        if (i > 0 && id !== undefined) pp['id'] = `${id}_${i + 1}`;
        links.push({ points: part.map(xy), props: pp });
      });
    } else {
      skipped++;
    }
  }
  if (skipped > 0) issues.push(`${skipped} features without a point or line geometry were skipped.`);
  const r = buildModel(nodes, links, opts);
  return { model: r.model, issues: [...issues, ...r.issues] };
}

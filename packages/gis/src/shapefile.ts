/**
 * ESRI shapefiles: reading point and line layers (with their Z and M variants) and
 * their dBASE attributes, and writing a network as a node layer and a link layer.
 * Exported coordinates are longitude and latitude (WGS 84, with a .prj) when the model
 * has a coordinate system, as for GeoJSON, and the model's own otherwise. Attribute
 * names are cut to dBASE's ten characters with names the importer reads back.
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
import { modelToGeoJSON, type ExportOptions, type Projector } from './geojson.ts';

export interface ShapefileLayer {
  name: string;
  shp: Uint8Array;
  dbf?: Uint8Array;
  /** The .prj file's WKT. */
  prj?: string;
  /** The .cpg file: the attributes' character encoding. */
  cpg?: string;
}

export type ShapeGeometry =
  { type: 'point'; x: number; y: number; z?: number } | { type: 'line'; parts: [number, number][][] };

export interface ShapeFeature {
  geometry: ShapeGeometry | null;
  props: Props;
}

export class ShapefileError extends Error {
  override name = 'ShapefileError';
}

const POINT = new Set([1, 11, 21]);
const MULTIPOINT = new Set([8, 18, 28]);
const LINE = new Set([3, 13, 23]);

/** Geometries of a .shp file, in record order. */
export function readShp(bytes: Uint8Array): { geometries: (ShapeGeometry | null)[]; skipped: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 100 || v.getInt32(0, false) !== 9994)
    throw new ShapefileError('This is not a .shp file.');
  const end = Math.min(bytes.length, v.getInt32(24, false) * 2);
  const geometries: (ShapeGeometry | null)[] = [];
  let skipped = 0;
  let p = 100;
  while (p + 8 <= end) {
    const len = v.getInt32(p + 4, false) * 2;
    const c = p + 8;
    p = c + len;
    if (len < 4 || p > end) break;
    const type = v.getInt32(c, true);
    if (type === 0) {
      geometries.push(null);
    } else if (POINT.has(type)) {
      const g: ShapeGeometry = { type: 'point', x: v.getFloat64(c + 4, true), y: v.getFloat64(c + 12, true) };
      if (type === 11) g.z = v.getFloat64(c + 20, true);
      geometries.push(g);
    } else if (MULTIPOINT.has(type)) {
      const n = v.getInt32(c + 36, true);
      if (n < 1) geometries.push(null);
      else {
        const g: ShapeGeometry = {
          type: 'point',
          x: v.getFloat64(c + 40, true),
          y: v.getFloat64(c + 48, true),
        };
        if (type === 18) g.z = v.getFloat64(c + 40 + 16 * n + 16, true);
        geometries.push(g);
      }
    } else if (LINE.has(type)) {
      const nParts = v.getInt32(c + 36, true);
      const nPoints = v.getInt32(c + 40, true);
      const parts: [number, number][][] = [];
      const pts = c + 44 + 4 * nParts;
      for (let k = 0; k < nParts; k++) {
        const a = v.getInt32(c + 44 + 4 * k, true);
        const b = k + 1 < nParts ? v.getInt32(c + 44 + 4 * (k + 1), true) : nPoints;
        const part: [number, number][] = [];
        for (let i = a; i < b; i++)
          part.push([v.getFloat64(pts + 16 * i, true), v.getFloat64(pts + 16 * i + 8, true)]);
        if (part.length >= 2) parts.push(part);
      }
      geometries.push(parts.length ? { type: 'line', parts } : null);
    } else {
      // Polygons and multipatches are not network elements.
      skipped++;
      geometries.push(null);
    }
  }
  return { geometries, skipped };
}

function decoderFor(cpg: string | undefined) {
  const c = (cpg ?? '').trim().toLowerCase();
  if (c.includes('utf') && c.includes('8')) return new TextDecoder('utf-8');
  return new TextDecoder('windows-1252');
}

/** Records of a .dbf file. */
export function readDbf(bytes: Uint8Array, cpg?: string): Props[] {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 33) throw new ShapefileError('This is not a .dbf file.');
  const count = v.getUint32(4, true);
  const headerLen = v.getUint16(8, true);
  const recordLen = v.getUint16(10, true);
  const dec = decoderFor(cpg);
  const ascii = new TextDecoder('ascii');
  const fields: { name: string; type: string; len: number; at: number }[] = [];
  let at = 1;
  for (let p = 32; p + 32 <= headerLen && bytes[p] !== 0x0d; p += 32) {
    const raw = bytes.subarray(p, p + 11);
    const z = raw.indexOf(0);
    const name = ascii.decode(z < 0 ? raw : raw.subarray(0, z)).trim();
    const len = bytes[p + 16]!;
    fields.push({ name, type: String.fromCharCode(bytes[p + 11]!), len, at });
    at += len;
  }
  const out: Props[] = [];
  for (let r = 0; r < count; r++) {
    const base = headerLen + r * recordLen;
    if (base + recordLen > bytes.length) break;
    const props: Props = {};
    for (const f of fields) {
      const text = dec.decode(bytes.subarray(base + f.at, base + f.at + f.len)).trim();
      if (text === '' || /^\*+$/.test(text)) props[f.name] = null;
      else if (f.type === 'N' || f.type === 'F') {
        const n = Number(text);
        props[f.name] = Number.isFinite(n) ? n : null;
      } else if (f.type === 'L') props[f.name] = /^[YyTt]/.test(text);
      else props[f.name] = text;
    }
    out.push(props);
  }
  return out;
}

export function readLayer(layer: ShapefileLayer): { features: ShapeFeature[]; skipped: number } {
  const { geometries, skipped } = readShp(layer.shp);
  const records = layer.dbf ? readDbf(layer.dbf, layer.cpg) : [];
  return { features: geometries.map((geometry, i) => ({ geometry, props: records[i] ?? {} })), skipped };
}

/** Group an archive's or a file selection's files into layers by base name. */
export function layersFromFiles(files: Map<string, Uint8Array>): ShapefileLayer[] {
  const by = new Map<string, Partial<ShapefileLayer> & { name: string }>();
  const text = new TextDecoder();
  for (const [path, data] of files) {
    const m = /^(.*?)\.(shp|dbf|prj|cpg)$/i.exec(path.split('/').pop() ?? path);
    if (!m) continue;
    const base = m[1]!;
    const ext = m[2]!.toLowerCase();
    let l = by.get(base.toLowerCase());
    if (!l) by.set(base.toLowerCase(), (l = { name: base }));
    if (ext === 'shp') l.shp = data;
    else if (ext === 'dbf') l.dbf = data;
    else if (ext === 'prj') l.prj = text.decode(data);
    else l.cpg = text.decode(data);
  }
  return [...by.values()].filter((l): l is ShapefileLayer => l.shp !== undefined);
}

/**
 * What a .prj says about coordinates: an EPSG code when it names one (or a UTM zone
 * on WGS 84), 'geographic' for longitude and latitude, or null if unknown.
 */
export function crsFromPrj(wkt: string): string | null {
  const s = wkt.trim();
  const authority = /AUTHORITY\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]\s*\]\s*$/i.exec(s);
  if (/^PROJCS/i.test(s)) {
    if (authority) return `EPSG:${authority[1]}`;
    const utm = /WGS[ _]?(?:19)?84[ _]+UTM[ _]+zone[ _]+(\d{1,2})([NS])/i.exec(s);
    if (utm) return `EPSG:${(utm[2]!.toUpperCase() === 'N' ? 32600 : 32700) + Number(utm[1])}`;
    return null;
  }
  if (/^GEOGCS/i.test(s)) return 'geographic';
  return null;
}

export interface ShapefileImportOptions extends BuildOptions {
  /** Turn longitude and latitude into model coordinates (for geographic layers). */
  project?: Projector | undefined;
}

/** Build a network from point and line layers. */
export function shapefilesToModel(layers: ShapefileLayer[], opts: ShapefileImportOptions): BuildResult {
  const nodes: RawNode[] = [];
  const links: RawLink[] = [];
  const issues: string[] = [];
  const xy = (x: number, y: number): [number, number] =>
    opts.project ? opts.project.fromLngLat(x, y) : [x, y];
  for (const layer of layers) {
    const { features, skipped } = readLayer(layer);
    if (skipped > 0)
      issues.push(`${layer.name}: ${skipped} shapes that are not points or lines were skipped.`);
    if (!layer.dbf) issues.push(`${layer.name}: no .dbf file, so no attributes.`);
    for (const f of features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'point') {
        const [x, y] = xy(g.x, g.y);
        const n: RawNode = { x, y, props: f.props };
        if (g.z !== undefined && Number.isFinite(g.z)) n.z = g.z;
        nodes.push(n);
      } else {
        g.parts.forEach((part, i) => {
          const props = { ...f.props };
          const id = str(props, 'id', 'name', 'link_id', 'label');
          if (i > 0 && id !== undefined) props['id'] = `${id}_${i + 1}`;
          links.push({ points: part.map(([x, y]) => xy(x, y)), props });
        });
      }
    }
  }
  const r = buildModel(nodes, links, opts);
  return { model: r.model, issues: [...issues, ...r.issues] };
}

const SHORT: Record<string, string> = {
  initial_quality: 'init_qual',
  volume_curve: 'vol_curve',
  description: 'descr',
};

const WGS84_PRJ =
  'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

interface Field {
  name: string;
  numeric: boolean;
  len: number;
  dec: number;
}

function fieldName(key: string, taken: Set<string>): string {
  const short = SHORT[key] ?? (key.startsWith('result_') ? `r_${key.slice(7)}` : key);
  let n = short.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 10);
  let k = 1;
  while (taken.has(n.toUpperCase())) n = `${n.slice(0, 8)}_${k++}`;
  taken.add(n.toUpperCase());
  return n;
}

function cellText(x: unknown): string {
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean') return String(x);
  return JSON.stringify(x);
}

function numText(v: number, f: Field): string {
  const t = f.dec > 0 ? v.toFixed(f.dec) : String(Math.round(v));
  return t.length > f.len ? v.toExponential(f.len - 7) : t;
}

/** A dBASE III table of the records, UTF-8 encoded. */
export function writeDbf(records: Props[]): Uint8Array {
  const enc = new TextEncoder();
  const keys: string[] = [];
  for (const r of records) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const taken = new Set<string>();
  const fields: (Field & { key: string })[] = keys.map((key) => {
    const vals = records.map((r) => r[key]).filter((x) => x !== null && x !== undefined);
    const numeric = vals.length > 0 && vals.every((x) => typeof x === 'number' && Number.isFinite(x));
    if (numeric) {
      const integer = vals.every((x) => Number.isInteger(x));
      return { key, name: fieldName(key, taken), numeric, len: 19, dec: integer ? 0 : 6 };
    }
    const len = Math.min(254, Math.max(1, ...vals.map((x) => enc.encode(cellText(x)).length)));
    return { key, name: fieldName(key, taken), numeric, len, dec: 0 };
  });
  const headerLen = 32 + 32 * fields.length + 1;
  const recordLen = 1 + fields.reduce((a, f) => a + f.len, 0);
  const out = new Uint8Array(headerLen + recordLen * records.length + 1);
  const v = new DataView(out.buffer);
  const now = new Date();
  out[0] = 0x03;
  out[1] = now.getUTCFullYear() - 1900;
  out[2] = now.getUTCMonth() + 1;
  out[3] = now.getUTCDate();
  v.setUint32(4, records.length, true);
  v.setUint16(8, headerLen, true);
  v.setUint16(10, recordLen, true);
  fields.forEach((f, i) => {
    const p = 32 + 32 * i;
    out.set(enc.encode(f.name), p);
    out[p + 11] = (f.numeric ? 'N' : 'C').charCodeAt(0);
    out[p + 16] = f.len;
    out[p + 17] = f.dec;
  });
  out[headerLen - 1] = 0x0d;
  records.forEach((r, i) => {
    let p = headerLen + i * recordLen;
    out[p++] = 0x20;
    for (const f of fields) {
      const x = r[f.key];
      const cell = new Uint8Array(f.len).fill(0x20);
      if (x !== null && x !== undefined) {
        if (f.numeric) {
          const t = enc.encode(numText(x as number, f));
          cell.set(t.subarray(0, f.len), Math.max(0, f.len - t.length));
        } else {
          let t = enc.encode(cellText(x));
          if (t.length > f.len) t = t.subarray(0, f.len);
          cell.set(t, 0);
        }
      }
      out.set(cell, p);
      p += f.len;
    }
  });
  out[out.length - 1] = 0x1a;
  return out;
}

function header(view: DataView, type: number, words: number, box: [number, number, number, number]): void {
  view.setInt32(0, 9994, false);
  view.setInt32(24, words, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, type, true);
  box.forEach((b, i) => view.setFloat64(36 + 8 * i, b, true));
}

/** A .shp and .shx pair for points (type 1) or polylines (type 3); null geometries become null shapes. */
export function writeShp(
  type: 1 | 3,
  shapes: ([number, number] | [number, number][] | null)[],
): { shp: Uint8Array; shx: Uint8Array } {
  const sizes = shapes.map((s) =>
    s === null ? 4 : type === 1 ? 20 : 4 + 32 + 8 + 4 + 16 * (s as [number, number][]).length,
  );
  const shpLen = 100 + sizes.reduce((a, n) => a + 8 + n, 0);
  const shp = new Uint8Array(shpLen);
  const shx = new Uint8Array(100 + 8 * shapes.length);
  const sv = new DataView(shp.buffer);
  const xv = new DataView(shx.buffer);
  let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const grow = ([x, y]: [number, number]) => {
    box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
  };
  let p = 100;
  shapes.forEach((s, i) => {
    xv.setInt32(100 + 8 * i, p / 2, false);
    xv.setInt32(104 + 8 * i, sizes[i]! / 2, false);
    sv.setInt32(p, i + 1, false);
    sv.setInt32(p + 4, sizes[i]! / 2, false);
    const c = p + 8;
    if (s === null) sv.setInt32(c, 0, true);
    else if (type === 1) {
      const pt = s as [number, number];
      grow(pt);
      sv.setInt32(c, 1, true);
      sv.setFloat64(c + 4, pt[0], true);
      sv.setFloat64(c + 12, pt[1], true);
    } else {
      const pts = s as [number, number][];
      let b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const q of pts) {
        grow(q);
        b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[0]), Math.max(b[3], q[1])];
      }
      sv.setInt32(c, 3, true);
      b.forEach((x, k) => sv.setFloat64(c + 4 + 8 * k, x, true));
      sv.setInt32(c + 36, 1, true);
      sv.setInt32(c + 40, pts.length, true);
      sv.setInt32(c + 44, 0, true);
      pts.forEach((q, k) => {
        sv.setFloat64(c + 48 + 16 * k, q[0], true);
        sv.setFloat64(c + 56 + 16 * k, q[1], true);
      });
    }
    p = c + sizes[i]!;
  });
  if (!Number.isFinite(box[0])) box = [0, 0, 0, 0];
  header(sv, type, shpLen / 2, box);
  header(xv, type, shx.length / 2, box);
  return { shp, shx };
}

/**
 * The network as shapefiles: `<base>_nodes` (points) and `<base>_links` (polylines),
 * each .shp, .shx, .dbf and .cpg, plus .prj when written in longitude and latitude.
 */
export function modelToShapefiles(
  m: model.Model,
  base: string,
  opts: ExportOptions = {},
): [string, Uint8Array][] {
  const fc = modelToGeoJSON(m, opts);
  const enc = new TextEncoder();
  const out: [string, Uint8Array][] = [];
  for (const [layer, type] of [
    ['nodes', 1],
    ['links', 3],
  ] as const) {
    const feats = fc.features.filter((f) => String(f.id).startsWith(layer === 'nodes' ? 'node:' : 'link:'));
    const shapes = feats.map((f) => {
      const g = f.geometry;
      if (!g) return null;
      if (g.type === 'Point') return [g.coordinates[0]!, g.coordinates[1]!] as [number, number];
      if (g.type === 'LineString') return g.coordinates.map((c) => [c[0]!, c[1]!] as [number, number]);
      return null;
    });
    const { shp, shx } = writeShp(type, shapes);
    const name = `${base}_${layer}`;
    out.push(
      [`${name}.shp`, shp],
      [`${name}.shx`, shx],
      [`${name}.dbf`, writeDbf(feats.map((f) => f.properties ?? {}))],
    );
    out.push([`${name}.cpg`, enc.encode('UTF-8')]);
    if (opts.project) out.push([`${name}.prj`, enc.encode(WGS84_PRJ)]);
  }
  return out;
}

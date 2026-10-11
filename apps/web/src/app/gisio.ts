/**
 * Importing networks from GIS files: GeoJSON (projected to its UTM zone when it is in
 * longitude and latitude), DXF drawings, and shapefiles (a .zip, or the .shp with its
 * .dbf and .prj chosen together), taking the coordinate system from the .prj when it
 * names one.
 */

import type { model } from '@waterstudio/core';
import {
  crsFromPrj,
  dxfToModel,
  geoJSONToModel,
  layersFromFiles,
  readShp,
  readZip,
  shapefilesToModel,
  type ShapefileLayer,
} from '@waterstudio/gis';
import { resolveCrs } from '../geo/crs.ts';
import { withCrs } from '../geo/model.ts';

export interface Imported {
  model: model.Model;
  issues: string[];
}

/** The UTM zone (as an EPSG code) containing a longitude and latitude. */
export function utmZone(lng: number, lat: number): string {
  const zone = Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1));
  return `EPSG:${lat >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`;
}

/**
 * Read a GeoJSON or DXF file into a model. GeoJSON in longitude and latitude is put
 * into the UTM zone of its centre, so lengths come out in metres.
 */
export function importGis(name: string, text: string): Imported {
  if (/\.dxf$/i.test(name)) {
    const r = dxfToModel(text, { snap: snapFor(extentOf(text)), units: 'LPS' });
    return {
      model: r.model,
      issues: [...r.issues, 'DXF has no coordinate system; set one to see a street map.'],
    };
  }
  const data: unknown = JSON.parse(text);
  const pts: [number, number][] = [];
  collectPositions(data, pts);
  const geographic = pts.length > 0 && pts.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
  if (!geographic) {
    const r = geoJSONToModel(data, { snap: snapFor(pts), units: 'LPS' });
    return {
      model: r.model,
      issues: [...r.issues, 'The coordinates are not longitude and latitude; no coordinate system was set.'],
    };
  }
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const code = utmZone(cx, cy);
  const crs = resolveCrs(code)!;
  const r = geoJSONToModel(data, { project: crs, snap: 0.5, units: 'LPS' });
  r.model.backdrop = withCrs(r.model.backdrop, code);
  return { model: r.model, issues: [...r.issues, `Coordinates were projected to ${crs.label} (${code}).`] };
}

function collectPositions(v: unknown, out: [number, number][]): void {
  if (Array.isArray(v)) {
    if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') out.push([v[0], v[1]]);
    else for (const x of v) collectPositions(x, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v))
      if (k === 'coordinates' || k === 'features' || k === 'geometry') collectPositions(x, out);
  }
}

/** Rough coordinates of a DXF drawing, for a snap tolerance. */
function extentOf(dxf: string): [number, number][] {
  const lines = dxf.split(/\r?\n/);
  const out: [number, number][] = [];
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i]!.trim() === '10' && lines[i + 2]!.trim() === '20')
      out.push([Number(lines[i + 1]), Number(lines[i + 3])]);
  }
  return out;
}

/** A snap tolerance of a millionth of the data's extent, at least a millimetre. */
function snapFor(pts: [number, number][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const span = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 1;
  return Math.max(span * 1e-6, 1e-3);
}

/** The files of a shapefile import: the entries of .zip archives and loose files, by name. */
export async function shapefileFiles(
  files: { name: string; bytes: Uint8Array }[],
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) for (const [n, b] of await readZip(f.bytes)) out.set(n, b);
    else out.set(f.name, f.bytes);
  }
  return out;
}

/** Build a network from shapefile layers, using the coordinate system their .prj names. */
export function importShapefiles(files: Map<string, Uint8Array>): Imported {
  const layers = layersFromFiles(files);
  if (layers.length === 0)
    throw new Error('No .shp file was found. Choose the .shp with its .dbf and .prj, or a .zip.');
  const prj = layers.find((l) => l.prj)?.prj;
  const kind = prj ? crsFromPrj(prj) : null;
  const pts = layerPoints(layers);
  if (kind === 'geographic' && pts.length > 0) {
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const code = utmZone(cx, cy);
    const crs = resolveCrs(code)!;
    const r = shapefilesToModel(layers, { project: crs, snap: 0.5, units: 'LPS' });
    r.model.backdrop = withCrs(r.model.backdrop, code);
    return { model: r.model, issues: [...r.issues, `Coordinates were projected to ${crs.label} (${code}).`] };
  }
  const r = shapefilesToModel(layers, { snap: snapFor(pts), units: 'LPS' });
  if (kind && resolveCrs(kind)) {
    r.model.backdrop = withCrs(r.model.backdrop, kind);
    return { model: r.model, issues: [...r.issues, `Coordinate system ${kind} taken from the .prj file.`] };
  }
  return {
    model: r.model,
    issues: [
      ...r.issues,
      prj
        ? 'The .prj file names a coordinate system WaterStudio does not know; set it to see a street map.'
        : 'There is no .prj file, so no coordinate system was set.',
    ],
  };
}

function layerPoints(layers: ShapefileLayer[]): [number, number][] {
  const out: [number, number][] = [];
  for (const l of layers) {
    for (const g of readShp(l.shp).geometries) {
      if (!g) continue;
      if (g.type === 'point') out.push([g.x, g.y]);
      else for (const part of g.parts) out.push(...part);
    }
  }
  return out;
}

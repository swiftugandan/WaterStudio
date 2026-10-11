/**
 * Plan lengths for auto-length, as EPANET's Auto-Length option computes them from the
 * map. With a coordinate system, distances are measured on the ellipsoid's mean sphere
 * from longitude and latitude, so map projections' scale errors do not creep into
 * lengths, and converted to feet for US units; without one, coordinates are taken to
 * be in the model's length units.
 */

import type { Document } from '@waterstudio/core';
import { modelCrs } from '../geo/model.ts';

const R = 6371008.8;
const FT_PER_M = 1 / 0.3048;

function haversine(a: [number, number], b: [number, number]): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** A length function for the document's current coordinate system and units. */
export function lengthMeasure(doc: Document, si: boolean): (points: number[]) => number {
  const crs = modelCrs(doc)?.crs;
  if (!crs) {
    return (p) => {
      let d = 0;
      for (let k = 2; k + 1 < p.length; k += 2) d += Math.hypot(p[k]! - p[k - 2]!, p[k + 1]! - p[k - 1]!);
      return d;
    };
  }
  const f = si ? 1 : FT_PER_M;
  return (p) => {
    let d = 0;
    let prev = crs.toLngLat(p[0]!, p[1]!);
    for (let k = 2; k + 1 < p.length; k += 2) {
      const next = crs.toLngLat(p[k]!, p[k + 1]!);
      d += haversine(prev, next);
      prev = next;
    }
    return d * f;
  };
}

/** The polyline of a link as flat [x, y, ...], end nodes included. */
export function linkPoints(doc: Document, link: number, vertices?: number[]): number[] {
  const a = doc.num(link, 'from');
  const b = doc.num(link, 'to');
  return [
    doc.num(a, 'x'),
    doc.num(a, 'y'),
    ...(vertices ?? (doc.get(link, 'vertices') as number[])),
    doc.num(b, 'x'),
    doc.num(b, 'y'),
  ];
}

/** For edits: the plan length of a link as the document stands inside the edit. */
export function planLengthOf(doc: Document, si: boolean): (link: number) => number | undefined {
  const measure = lengthMeasure(doc, si);
  return (link) => {
    const d = measure(linkPoints(doc, link));
    return Number.isFinite(d) && d > 0 ? d : undefined;
  };
}

/** Initial values for a new link: its plan length when auto-length is on and it is a pipe. */
export function autoLength(
  state: { prefs: { autoLength: string }; store: { doc: Document }; units: { si: boolean } },
  kind: string,
  points: number[],
): { length: number } | undefined {
  if (state.prefs.autoLength !== 'on' || kind !== 'pipe') return undefined;
  const d = lengthMeasure(state.store.doc, state.units.si)(points);
  return Number.isFinite(d) && d > 0 ? { length: Math.round(d * 100) / 100 } : undefined;
}

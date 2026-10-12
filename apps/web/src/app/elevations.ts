/**
 * Node elevations from a digital elevation model or online terrain: which nodes take
 * one, where each lies on the DEM, and the undoable edit that sets them.
 */

import type { Document, Store, UnitSystem } from '@waterstudio/core';
import { sample, type Raster } from '@waterstudio/gis';
import { resolveCrs, type Crs } from '../geo/crs.ts';

export interface ElevationOptions {
  /** Every junction and tank, or only the selected ones. */
  scope: 'all' | 'selected';
  /** Leave nodes that already have a non-zero elevation alone. */
  onlyZero: boolean;
  /** The DEM's heights are in feet (otherwise metres). */
  demFeet: boolean;
}

export interface ElevationPlan {
  /** Node handle and its new elevation in model units. */
  updates: [number, number][];
  /** Nodes that fall outside the DEM or on cells without data. */
  outside: string[];
  /** Nodes considered. */
  considered: number;
}

/** Junctions and tanks the options apply to. */
export function elevationTargets(
  doc: Document,
  selection: ReadonlySet<number>,
  opts: ElevationOptions,
): number[] {
  const out: number[] = [];
  for (const h of doc.nodeHandles()) {
    const kind = doc.kind(h);
    if (kind !== 'junction' && kind !== 'tank') continue;
    if (opts.scope === 'selected' && !selection.has(h)) continue;
    if (opts.onlyZero && doc.num(h, 'elevation') !== 0) continue;
    out.push(h);
  }
  return out;
}

/** Factor from DEM height units to the model's elevation units. */
export function heightFactor(units: UnitSystem, demFeet: boolean): number {
  const toMetres = demFeet ? 0.3048 : 1;
  return units.si ? toMetres : toMetres / 0.3048;
}

/**
 * Elevations for `targets` from `heightAt` (DEM units at model coordinates), rounded
 * to hundredths in model units.
 */
export function planElevations(
  doc: Document,
  targets: readonly number[],
  heightAt: (x: number, y: number, h: number) => number,
  factor: number,
): ElevationPlan {
  const updates: [number, number][] = [];
  const outside: string[] = [];
  for (const h of targets) {
    const x = doc.num(h, 'x');
    const y = doc.num(h, 'y');
    const z = Number.isFinite(x) && Number.isFinite(y) ? heightAt(x, y, h) : NaN;
    if (!Number.isFinite(z)) {
      outside.push(doc.id(h));
      continue;
    }
    updates.push([h, Math.round(z * factor * 100) / 100]);
  }
  return { updates, outside, considered: targets.length };
}

/** Heights in DEM units at model coordinates, reprojecting when the DEM names another CRS. */
export function demSampler(raster: Raster, model: Crs | null): (x: number, y: number) => number {
  if (raster.epsg === null || !model) return (x, y) => sample(raster, x, y);
  const code = `EPSG:${raster.epsg}`;
  if (model.code.toUpperCase() === code) return (x, y) => sample(raster, x, y);
  const dem = resolveCrs(code);
  if (!dem) {
    throw new Error(
      `The DEM is in ${code}, which WaterStudio cannot convert to; reproject it to the network's coordinate system (${model.code}).`,
    );
  }
  return (x, y) => {
    const [lng, lat] = model.toLngLat(x, y);
    const [dx, dy] = dem.fromLngLat(lng, lat);
    return sample(raster, dx, dy);
  };
}

/** Set the planned elevations as one undoable edit; returns how many changed. */
export function applyElevations(store: Store, plan: ElevationPlan, source: string): number {
  const changes = plan.updates.filter(([h, z]) => store.doc.num(h, 'elevation') !== z);
  if (changes.length === 0) return 0;
  store.transact(`Elevations of ${changes.length} nodes from ${source}`, (tx) => {
    for (const [h, z] of changes) tx.set(h, 'elevation', z);
  });
  return changes.length;
}

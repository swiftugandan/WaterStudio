/**
 * EPANET's calibration report. Calibration data are measurements at nodes or links over
 * time, in EPANET's .dat format: `location time value` per line, where a line without a
 * location continues the previous one and text after `;` is a comment. Each measurement
 * is compared with the simulated value at that time (interpolated between report
 * periods); the report gives, per location and for the network, the number of
 * observations, the observed and computed means, the mean absolute error and the RMS
 * error, and the correlation between observed and computed means.
 */

import { getfloat, hour } from '@waterstudio/core';

export const CALIBRATION_VARIABLES = ['demand', 'head', 'pressure', 'quality', 'flow', 'velocity'] as const;
export type CalibrationVariable = (typeof CALIBRATION_VARIABLES)[number];

export const isLinkVariable = (v: CalibrationVariable) => v === 'flow' || v === 'velocity';

export interface Observation {
  location: string;
  /** Hours from the start of the simulation. */
  hours: number;
  value: number;
}

export interface CalibrationData {
  fileName: string;
  observations: Observation[];
}

export function parseCalibration(text: string): { observations: Observation[]; issues: string[] } {
  const observations: Observation[] = [];
  const issues: string[] = [];
  let location = '';
  for (const [n, raw] of text.split(/\r?\n/).entries()) {
    const t = raw
      .split(';')[0]!
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (t.length === 0) continue;
    let time: string;
    let value: string;
    if (t.length >= 3) [location, time, value] = t as [string, string, string];
    else if (t.length === 2 && location !== '') [time, value] = t as [string, string];
    else {
      issues.push(`Line ${n + 1}: expected a location, a time and a value.`);
      continue;
    }
    const h = hour(time);
    const v = getfloat(value);
    if (h < 0 || v === undefined) {
      issues.push(`Line ${n + 1}: “${raw.trim()}” has an unreadable time or value.`);
      continue;
    }
    observations.push({ location, hours: h, value: v });
  }
  return { observations, issues };
}

/** The series at `x` by linear interpolation, or NaN outside it. */
export function interpolate(xs: ArrayLike<number>, ys: ArrayLike<number>, x: number): number {
  const n = xs.length;
  if (n === 0 || x < xs[0]! - 1e-9 || x > xs[n - 1]! + 1e-9) return NaN;
  if (n === 1) return ys[0]!;
  let i = 1;
  while (i < n - 1 && xs[i]! < x) i++;
  const x0 = xs[i - 1]!;
  const x1 = xs[i]!;
  if (x1 === x0) return ys[i]!;
  const t = Math.min(1, Math.max(0, (x - x0) / (x1 - x0)));
  return ys[i - 1]! + t * (ys[i]! - ys[i - 1]!);
}

export interface CalibrationRow {
  location: string;
  n: number;
  observedMean: number;
  computedMean: number;
  meanError: number;
  rmsError: number;
}

export interface CalibrationReport {
  rows: CalibrationRow[];
  network: CalibrationRow;
  /** Pearson correlation of observed and computed means over locations (null with fewer than two). */
  correlation: number | null;
  pairs: { location: string; hours: number; observed: number; computed: number }[];
  /** Locations with no simulated values (unknown IDs). */
  unknown: string[];
  /** Observations outside the simulated period. */
  outside: number;
}

function stats(location: string, obs: number[], comp: number[]): CalibrationRow {
  const n = obs.length;
  let so = 0;
  let sc = 0;
  let se = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    so += obs[i]!;
    sc += comp[i]!;
    const e = comp[i]! - obs[i]!;
    se += Math.abs(e);
    s2 += e * e;
  }
  return {
    location,
    n,
    observedMean: n ? so / n : NaN,
    computedMean: n ? sc / n : NaN,
    meanError: n ? se / n : NaN,
    rmsError: n ? Math.sqrt(s2 / n) : NaN,
  };
}

export function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  if (n < 2) return null;
  const ma = a.reduce((s, x) => s + x, 0) / n;
  const mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa === 0 || sbb === 0 ? null : sab / Math.sqrt(saa * sbb);
}

/**
 * Compare observations with simulated series. `series(location)` gives the simulated
 * values at report times `hours`, or null for an unknown location.
 */
export function calibrationReport(
  observations: Observation[],
  hours: number[],
  series: (location: string) => ArrayLike<number> | null,
): CalibrationReport {
  const by = new Map<string, Observation[]>();
  for (const o of observations) {
    let l = by.get(o.location);
    if (!l) by.set(o.location, (l = []));
    l.push(o);
  }
  const rows: CalibrationRow[] = [];
  const pairs: CalibrationReport['pairs'] = [];
  const unknown: string[] = [];
  let outside = 0;
  const allObs: number[] = [];
  const allComp: number[] = [];
  for (const [location, list] of by) {
    const ys = series(location);
    if (!ys) {
      unknown.push(location);
      continue;
    }
    const obs: number[] = [];
    const comp: number[] = [];
    for (const o of list) {
      const c = interpolate(hours, ys, o.hours);
      if (!Number.isFinite(c)) {
        outside++;
        continue;
      }
      obs.push(o.value);
      comp.push(c);
      pairs.push({ location, hours: o.hours, observed: o.value, computed: c });
    }
    if (obs.length === 0) continue;
    rows.push(stats(location, obs, comp));
    allObs.push(...obs);
    allComp.push(...comp);
  }
  return {
    rows,
    network: stats('Network', allObs, allComp),
    correlation: pearson(
      rows.map((r) => r.observedMean),
      rows.map((r) => r.computedMean),
    ),
    pairs,
    unknown,
    outside,
  };
}

/** Axis scales for charts: extents with a little headroom and "nice" tick values. */

export interface Ticks {
  min: number;
  max: number;
  step: number;
  values: number[];
}

/** Extent of finite values, or [0, 1] if there are none. */
export function extent(values: Iterable<number>): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo === Infinity ? [0, 1] : [lo, hi];
}

/** A step from {1, 2, 2.5, 5} × 10^k giving about `count` intervals over the span. */
export function niceStep(span: number, count: number): number {
  if (!(span > 0)) return 1;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/** Ticks covering [lo, hi], widened to whole steps. A flat range gets a unit band. */
export function niceTicks(lo: number, hi: number, count = 5): Ticks {
  if (lo === hi) {
    const d = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    lo -= d;
    hi += d;
  }
  const step = niceStep(hi - lo, count);
  const min = Math.floor(lo / step + 1e-9) * step;
  const max = Math.ceil(hi / step - 1e-9) * step;
  const values: number[] = [];
  for (let v = min; v <= max + step * 1e-6; v += step) values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { min, max, step, values };
}

/** A tick label with only the decimals the step needs. */
export function tickLabel(v: number, step: number): string {
  const frac = Number(step.toPrecision(12)).toString().split('.')[1] ?? '';
  const decimals = /e-(\d+)/.test(frac) ? 6 : Math.min(6, frac.length);
  const s = v.toFixed(decimals);
  return Number(s) === 0 ? (0).toFixed(decimals) : s;
}

/** Hours as h:mm, with days when the run is longer than one. */
export function hoursLabel(hours: number): string {
  const total = Math.round(hours * 60);
  const d = Math.floor(total / 1440);
  const h = Math.floor((total % 1440) / 60);
  const m = total % 60;
  return `${d > 0 ? `${d}d ` : ''}${h}:${String(m).padStart(2, '0')}`;
}

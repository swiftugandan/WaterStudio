/**
 * How the scene is painted: theme colours, the legend that turns result values into
 * colour classes, and per-element flags (selected, hovered, hidden).
 */

import { colormaps, themes, type ThemeName } from '@waterstudio/ui';

export interface Theme {
  background: string;
  grid: string;
  link: string;
  node: string;
  label: string;
  selection: string;
  hover: string;
}

export function themeFor(name: ThemeName): Theme {
  const t = themes[name];
  return {
    background: t.canvasBg,
    grid: t.canvasGrid,
    link: t.canvasLink,
    node: t.canvasNode,
    label: t.canvasLabel,
    selection: t.canvasSelection,
    hover: t.canvasHover,
  };
}

/** `breaks` are the class boundaries, ascending; `colors` has one more entry than `breaks`. */
export interface Legend {
  breaks: number[];
  colors: string[];
}

/** Element flags, one byte per element. */
export const FLAG_SELECTED = 1;
export const FLAG_HOVER = 2;
export const FLAG_HIDDEN = 4;

/**
 * Colour classes per element: 0 is the theme's default colour, k > 0 is
 * `legend.colors[k - 1]`. Values that are NaN, or a missing column, get class 0.
 */
export interface Paint {
  nodeClass: Uint8Array;
  linkClass: Uint8Array;
  nodeLegend: Legend | null;
  linkLegend: Legend | null;
}

export function emptyPaint(nodeCount: number, linkCount: number): Paint {
  return {
    nodeClass: new Uint8Array(nodeCount),
    linkClass: new Uint8Array(linkCount),
    nodeLegend: null,
    linkLegend: null,
  };
}

export function classify(
  values: ArrayLike<number>,
  legend: Legend,
  out: Uint8Array = new Uint8Array(values.length),
): Uint8Array {
  const b = legend.breaks;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    if (Number.isNaN(v)) {
      out[i] = 0;
      continue;
    }
    let k = 0;
    while (k < b.length && v >= b[k]!) k++;
    out[i] = k + 1;
  }
  return out;
}

/** Round to a "nice" number with two significant figures. */
function nice(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const p = 10 ** Math.floor(Math.log10(Math.abs(x)) - 1);
  return Math.round(x / p) * p;
}

/** Legend breaks at quantiles of the values, rounded to nice numbers and de-duplicated. */
export function quantileBreaks(values: ArrayLike<number>, classes = 5): number[] {
  const v = Array.from(values)
    .filter((x) => Number.isFinite(x))
    .sort((a, b) => a - b);
  if (v.length === 0) return [];
  const out: number[] = [];
  for (let k = 1; k < classes; k++) {
    const b = nice(v[Math.min(v.length - 1, Math.floor((k / classes) * v.length))]!);
    if (out.length === 0 || b > out.at(-1)!) out.push(b);
  }
  return out;
}

export type RampName = keyof typeof colormaps;

/** `n` colours sampled evenly from a ramp. */
export function rampColors(name: RampName, n: number): string[] {
  const stops = colormaps[name];
  if (name === 'epanet' && n === stops.length) return [...stops];
  return Array.from(
    { length: n },
    (_, i) => stops[Math.round((i / Math.max(1, n - 1)) * (stops.length - 1))]!,
  );
}

export function legendFor(values: ArrayLike<number>, ramp: RampName = 'viridis', classes = 5): Legend {
  const breaks = quantileBreaks(values, classes);
  return { breaks, colors: rampColors(ramp, breaks.length + 1) };
}

/** `#rrggbb` to [r, g, b] in 0..1. */
export function rgb(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1, 7), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export interface DrawOptions {
  /** Link width in CSS pixels. */
  linkWidth: number;
  /** Junction radius in CSS pixels. */
  nodeRadius: number;
  /** Symbol size (tanks, reservoirs, pumps, valves) in CSS pixels. */
  symbolSize: number;
  /** Hide junctions when links are shorter than this many pixels on screen. */
  junctionMinSpacing: number;
}

export const defaultDrawOptions: DrawOptions = {
  linkWidth: 2,
  nodeRadius: 3,
  symbolSize: 20,
  junctionMinSpacing: 8,
};

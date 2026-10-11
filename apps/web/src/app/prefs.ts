/** Per-viewer preferences, remembered in this browser when storage is available. */

import type { Preference } from '@waterstudio/render';
import { Emitter } from './emitter.ts';

export type ThemePref = 'system' | 'light' | 'dark';
export type DensityPref = 'comfortable' | 'compact';
export type BasemapPref = 'on' | 'off';

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the preference lasts for this page only.
  }
}

/** What the map shows besides the network, as EPANET's map options. */
export interface MapOptions {
  nodeIds: boolean;
  nodeValues: boolean;
  linkIds: boolean;
  linkValues: boolean;
  flowArrows: boolean;
  /** The model's own map labels ([LABELS]). */
  mapLabels: boolean;
  /** Node, link and symbol size, 1 (small) to 5 (large). */
  size: number;
}

export const DEFAULT_MAP_OPTIONS: MapOptions = {
  nodeIds: false,
  nodeValues: false,
  linkIds: false,
  linkValues: false,
  flowArrows: false,
  mapLabels: true,
  size: 3,
};

function readMap(): MapOptions {
  try {
    const v = JSON.parse(localStorage.getItem('ws.map') ?? '{}') as Partial<MapOptions>;
    const out = { ...DEFAULT_MAP_OPTIONS };
    for (const k of Object.keys(out) as (keyof MapOptions)[]) {
      if (typeof v[k] === typeof out[k]) (out as Record<string, unknown>)[k] = v[k];
    }
    out.size = Math.min(5, Math.max(1, Math.round(out.size)));
    return out;
  } catch {
    return { ...DEFAULT_MAP_OPTIONS };
  }
}

/** Renderer sizes for a map size step. */
export function drawSizes(size: number): { linkWidth: number; nodeRadius: number; symbolSize: number } {
  const i = Math.min(5, Math.max(1, size)) - 1;
  return {
    linkWidth: [1, 1.5, 2, 3, 4][i]!,
    nodeRadius: [2, 2.5, 3, 4, 5][i]!,
    symbolSize: [14, 17, 20, 24, 28][i]!,
  };
}

export class Prefs extends Emitter {
  theme = read<ThemePref>('ws.theme', ['system', 'light', 'dark'], 'system');
  density = read<DensityPref>('ws.density', ['comfortable', 'compact'], 'comfortable');
  renderer = read<Preference>('ws.renderer', ['auto', 'webgpu', 'canvas2d'], 'auto');
  /** Show the street map under networks with a known coordinate system. */
  basemap = read<BasemapPref>('ws.basemap', ['on', 'off'], 'on');
  map: MapOptions = readMap();

  constructor() {
    super();
    this.apply();
  }

  set(
    p: Partial<{ theme: ThemePref; density: DensityPref; renderer: Preference; basemap: BasemapPref }>,
  ): void {
    if (p.theme) this.theme = p.theme;
    if (p.density) this.density = p.density;
    if (p.renderer) this.renderer = p.renderer;
    if (p.basemap) this.basemap = p.basemap;
    write('ws.basemap', this.basemap);
    write('ws.theme', this.theme);
    write('ws.density', this.density);
    write('ws.renderer', this.renderer);
    this.apply();
    this.emit();
  }

  setMap(p: Partial<MapOptions>): void {
    this.map = { ...this.map, ...p };
    write('ws.map', JSON.stringify(this.map));
    this.emit();
  }

  /** The theme actually shown, resolving "system". */
  get resolvedTheme(): 'light' | 'dark' {
    if (this.theme !== 'system') return this.theme;
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light';
  }

  private apply(): void {
    const root = document.documentElement;
    if (this.theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', this.theme);
    root.setAttribute('data-density', this.density);
  }
}

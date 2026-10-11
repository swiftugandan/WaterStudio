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
  /** A small map of the whole network with the view outlined. */
  overview: boolean;
}

export const DEFAULT_MAP_OPTIONS: MapOptions = {
  nodeIds: false,
  nodeValues: false,
  linkIds: false,
  linkValues: false,
  flowArrows: false,
  mapLabels: true,
  size: 3,
  overview: false,
};

function readDecimals(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem('ws.decimals') ?? '{}') as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(v).filter(
        (e): e is [string, number] => typeof e[1] === 'number' && e[1] >= 0 && e[1] <= 6,
      ),
    );
  } catch {
    return {};
  }
}

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
  /** EPANET's Auto-Length: pipe lengths follow the map as links are drawn and nodes moved. */
  autoLength = read<'on' | 'off'>('ws.autolength', ['on', 'off'], 'off');
  /** Single-character shortcuts (V, J, P …); they can be turned off (WCAG 2.1.4). */
  singleKeys = read<'on' | 'off'>('ws.singlekeys', ['on', 'off'], 'on');
  /** Decimal places for each result variable (EPANET's Preferences › Formats). */
  decimals: Record<string, number> = readDecimals();

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

  setDecimals(variable: string, places: number | null): void {
    const next = Object.fromEntries(Object.entries(this.decimals).filter(([k]) => k !== variable));
    if (places !== null) next[variable] = Math.min(6, Math.max(0, Math.round(places)));
    this.decimals = next;
    write('ws.decimals', JSON.stringify(next));
    this.emit();
  }

  /** Decimal places for a variable: the preference, or EPANET's defaults (2; status 0). */
  places(variable: string): number {
    return this.decimals[variable] ?? (variable === 'status' ? 0 : 2);
  }

  setSingleKeys(on: boolean): void {
    this.singleKeys = on ? 'on' : 'off';
    write('ws.singlekeys', this.singleKeys);
    this.emit();
  }

  setAutoLength(on: boolean): void {
    this.autoLength = on ? 'on' : 'off';
    write('ws.autolength', this.autoLength);
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

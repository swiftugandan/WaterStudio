/**
 * The basemap: a MapLibre map under the network canvas, following the network camera.
 * MapLibre is loaded only when a basemap is first shown, so it costs nothing until then.
 * The map takes no input of its own; every gesture goes to the network view.
 */

import type { Camera } from '@waterstudio/render';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import type { Crs } from './crs.ts';
import { basemapView } from './view.ts';

export const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

export class Basemap {
  private map: MapLibreMap | null = null;
  private loading: Promise<void> | null = null;
  private readonly el: HTMLDivElement;
  private crs: Crs | null = null;
  private last: Camera | null = null;
  private tiles = OSM_TILES;
  private destroyed = false;
  /** Set when the map cannot be shown (no WebGL); the reason, for the user. */
  failure: string | null = null;

  private readonly onFailure: (reason: string) => void;
  private size = '';

  constructor(container: HTMLElement, onFailure: (reason: string) => void) {
    this.onFailure = onFailure;
    this.el = document.createElement('div');
    this.el.className = 'basemap';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.hidden = true;
    container.prepend(this.el);
  }

  /** Show the basemap for `crs`, or hide it with null. */
  show(crs: Crs | null, tiles = OSM_TILES): void {
    this.crs = crs;
    this.el.hidden = crs === null || this.failure !== null;
    if (!crs || this.failure) return;
    if (tiles !== this.tiles && this.map) {
      this.tiles = tiles;
      this.map.setStyle(style(tiles));
    }
    this.tiles = tiles;
    void this.ensure().then(() => this.last && this.follow(this.last));
  }

  private ensure(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const [{ Map, setWorkerUrl }, worker] = await Promise.all([
          import('maplibre-gl'),
          // MapLibre looks for its worker next to its own module; build it as a worker
          // of ours instead, with its shared chunk bundled in.
          import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (this.destroyed) return;
        setWorkerUrl(worker.default);
        this.map = new Map({
          container: this.el,
          style: style(this.tiles),
          interactive: false,
          attributionControl: false,
          fadeDuration: 0,
        });
        this.map.on('error', () => {
          // Tile errors (offline, blocked) leave the network drawn on a blank map.
        });
      } catch (e) {
        this.failure = e instanceof Error ? e.message : String(e);
        this.el.hidden = true;
        this.onFailure(this.failure);
      }
    })();
    return this.loading;
  }

  /** Line the basemap up with the network camera. */
  follow(cam: Camera): void {
    this.last = cam;
    const map = this.map;
    if (!map || !this.crs || this.el.hidden) return;
    const v = basemapView(cam, this.crs);
    if (!v) return;
    const size = `${cam.width}x${cam.height}`;
    if (size !== this.size) {
      this.size = size;
      map.resize();
    }
    map.jumpTo({ center: v.center, zoom: v.zoom, bearing: v.bearing });
  }

  destroy(): void {
    this.destroyed = true;
    this.map?.remove();
    this.el.remove();
  }
}

function style(tiles: string): StyleSpecification {
  return {
    version: 8,
    sources: {
      base: { type: 'raster', tiles: [tiles], tileSize: 256, maxzoom: 19 },
    },
    layers: [{ id: 'base', type: 'raster', source: 'base' }],
  };
}

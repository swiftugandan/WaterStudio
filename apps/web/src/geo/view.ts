/**
 * Turning the network camera into a basemap camera. The network is drawn in its own
 * coordinate system; the basemap (Web Mercator) follows with the centre, zoom and
 * bearing that line it up at the centre of the view, which is exact for conformal
 * systems at the centre and within a pixel or two across a city.
 */

import type { CameraState } from '@waterstudio/render';
import type { Crs } from './crs.ts';

const R = 6378137;
/** MapLibre's world is 512 pixels wide at zoom 0. */
const TILE = 512;

export function mercator(lng: number, lat: number): [number, number] {
  const phi = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  return [(lng * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + phi / 2))];
}

export interface BasemapView {
  center: [number, number];
  zoom: number;
  /** Degrees clockwise from north that the top of the view faces. */
  bearing: number;
}

export function basemapView(cam: CameraState, crs: Crs): BasemapView | null {
  // A probe of 100 pixels along the world's x axis, from the centre.
  const d = 100 / cam.scale;
  const c = crs.toLngLat(cam.cx, cam.cy);
  const e = crs.toLngLat(cam.cx + d, cam.cy);
  if (![...c, ...e].every(Number.isFinite) || Math.abs(c[1]) > 85) return null;
  const [mx0, my0] = mercator(c[0], c[1]);
  const [mx1, my1] = mercator(e[0], e[1]);
  const dist = Math.hypot(mx1 - mx0, my1 - my0);
  if (!(dist > 0)) return null;
  const metresPerPixel = dist / 100;
  const zoom = Math.log2((2 * Math.PI * R) / (TILE * metresPerPixel));
  // The world's x axis points this many degrees counter-clockwise of east on the map;
  // the map must turn clockwise by as much, which is a negative bearing.
  const angle = (Math.atan2(my1 - my0, mx1 - mx0) * 180) / Math.PI;
  return { center: c, zoom, bearing: -angle };
}

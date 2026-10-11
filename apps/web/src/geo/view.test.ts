import { describe, expect, it } from 'vitest';
import { resolveCrs, type Crs } from './crs.ts';
import { basemapView, mercator } from './view.ts';

const cam = (cx: number, cy: number, scale: number) => ({ cx, cy, scale, width: 800, height: 600 });

describe('basemap view', () => {
  it('matches Web Mercator exactly', () => {
    const c = resolveCrs('EPSG:3857')!;
    // At zoom 0 one pixel is 2πR / 512 metres.
    const v = basemapView(cam(0, 0, 512 / (2 * Math.PI * 6378137)), c)!;
    expect(v.zoom).toBeCloseTo(0, 9);
    expect(v.bearing).toBeCloseTo(0, 9);
    expect(v.center).toEqual([0, 0]);
  });

  it('follows UTM, including grid convergence away from the central meridian', () => {
    const c = resolveCrs('EPSG:32633')!;
    const mid = basemapView(cam(500000, 5000000, 1), c)!;
    expect(Math.abs(mid.bearing)).toBeLessThan(1e-3);
    // 1 px per metre near 45°N: Mercator stretches by sec(lat), about 1.41.
    expect(mid.zoom).toBeCloseTo(
      Math.log2((2 * Math.PI * 6378137 * Math.cos((45.15 * Math.PI) / 180)) / 512),
      2,
    );
    const east = basemapView(cam(700000, 5000000, 1), c)!;
    expect(Math.abs(east.bearing)).toBeGreaterThan(1);
  });

  it('turns the map against a rotated system', () => {
    // A system whose x axis points north-east.
    const s = Math.SQRT1_2;
    const rot: Crs = {
      code: 'test',
      label: 'test',
      toLngLat: (x, y) => [
        ((x * s - y * s) / 6378137) * (180 / Math.PI),
        ((x * s + y * s) / 6378137) * (180 / Math.PI),
      ],
      fromLngLat: () => [0, 0],
    };
    const v = basemapView(cam(0, 0, 1), rot)!;
    expect(v.bearing).toBeCloseTo(-45, 1);
  });

  it('projects to Web Mercator', () => {
    expect(mercator(180, 0)[0]).toBeCloseTo(Math.PI * 6378137, 3);
  });
});

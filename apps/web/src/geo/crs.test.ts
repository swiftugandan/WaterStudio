import { describe, expect, it } from 'vitest';
import { looksGeographic, resolveCrs } from './crs.ts';

describe('coordinate systems', () => {
  it('converts UTM to longitude and latitude and back', () => {
    const c = resolveCrs('epsg:32633')!;
    expect(c.label).toBe('WGS 84 / UTM zone 33N');
    // Zone 33's central meridian, at the false easting.
    const [lng, lat] = c.toLngLat(500000, 5000000);
    expect(lng).toBeCloseTo(15, 9);
    expect(lat).toBeCloseTo(45.1535, 3);
    const [x, y] = c.fromLngLat(lng, lat);
    expect(x).toBeCloseTo(500000, 4);
    expect(y).toBeCloseTo(5000000, 4);
  });

  it('knows national grids and Web Mercator', () => {
    // Big Ben in British National Grid.
    const [lng, lat] = resolveCrs('EPSG:27700')!.toLngLat(530268, 179640);
    expect(lng).toBeCloseTo(-0.1246, 3);
    expect(lat).toBeCloseTo(51.5007, 3);
    expect(resolveCrs('EPSG:3857')!.toLngLat(0, 0)).toEqual([0, 0]);
  });

  it('accepts proj4 strings and rejects nonsense', () => {
    expect(resolveCrs('+proj=utm +zone=10 +datum=WGS84 +units=m')!.label).toBe('Custom (proj4)');
    expect(resolveCrs('EPSG:99999')).toBeNull();
    expect(resolveCrs('EPSG:32699')).toBeNull();
    expect(resolveCrs('')).toBeNull();
  });

  it('spots longitude-latitude coordinates', () => {
    expect(looksGeographic(-0.2, 51.4, -0.1, 51.6)).toBe(true);
    expect(looksGeographic(0, 0, 10000, 8000)).toBe(false);
  });
});

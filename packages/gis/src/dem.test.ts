import { writeArrayBuffer } from 'geotiff';
import { describe, expect, it } from 'vitest';
import { rasterBounds, readAsciiGrid, readDem, readGeoTiff, sample } from './dem.ts';

// 3 × 2 cells of 10 m; the lower-left corner at (1000, 2000).
const ASC = `ncols 3
nrows 2
xllcorner 1000
yllcorner 2000
cellsize 10
NODATA_value -9999
10 20 30
40 50 -9999
`;

describe('elevation models', () => {
  it('reads an ASCII grid with its cell centres, north row first', () => {
    const r = readAsciiGrid(ASC);
    expect([r.width, r.height, r.x0, r.y0, r.dx, r.dy]).toEqual([3, 2, 1005, 2015, 10, -10]);
    expect(Number.isNaN(r.values[5]!)).toBe(true);
    expect(rasterBounds(r)).toEqual([1000, 2000, 1030, 2020]);
  });

  it('interpolates between cell centres and skips cells without data', () => {
    const r = readAsciiGrid(ASC);
    expect(sample(r, 1005, 2015)).toBe(10);
    expect(sample(r, 1010, 2015)).toBe(15); // half way between 10 and 20
    expect(sample(r, 1010, 2010)).toBe(30); // centre of four: (10+20+40+50)/4
    expect(sample(r, 1022, 2005)).toBe(50); // its other neighbour has no data
    expect(sample(r, 1001, 2019)).toBe(10); // within the edge cell
    expect(sample(r, 990, 2010)).toBeNaN(); // outside
  });

  it('reads a GeoTIFF with its origin, resolution, no-data value and EPSG code', async () => {
    const values = Float32Array.from([10, 20, 30, 40, 50, -9999]);
    const bytes = writeArrayBuffer(values, {
      width: 3,
      height: 2,
      ModelPixelScale: [10, 10, 0],
      ModelTiepoint: [0, 0, 0, 1000, 2020, 0],
      ProjectedCSTypeGeoKey: 32633,
      GTRasterTypeGeoKey: 1,
      GDAL_NODATA: '-9999',
    });
    const r = await readGeoTiff(bytes);
    expect([r.width, r.height, r.x0, r.y0, r.dx, r.dy, r.epsg]).toEqual([3, 2, 1005, 2015, 10, -10, 32633]);
    expect(sample(r, 1010, 2010)).toBe(30);
    expect(Number.isNaN(r.values[5]!)).toBe(true);
    const viaName = await readDem('dem.tif', bytes);
    expect(viaName.width).toBe(3);
    const asc = await readDem('dem.asc', new TextEncoder().encode(ASC).buffer);
    expect(asc.epsg).toBeNull();
  });
});

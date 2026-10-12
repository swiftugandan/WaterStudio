/**
 * Digital elevation models: GeoTIFF and ESRI ASCII grids read into one raster form,
 * and elevations sampled from them by bilinear interpolation. No DOM.
 */

import { fromArrayBuffer } from 'geotiff';

/** A single-band grid of heights, north up. */
export interface Raster {
  width: number;
  height: number;
  /** World coordinates of the centre of the top-left cell. */
  x0: number;
  y0: number;
  /** Cell size along x (positive) and y (negative for north-up grids). */
  dx: number;
  dy: number;
  /** Row-major heights, top row first; NaN where there is no data. */
  values: Float32Array;
  /** The grid's coordinate system as an EPSG code, when the file says. */
  epsg: number | null;
}

/** Read an ESRI ASCII grid (.asc). */
export function readAsciiGrid(text: string): Raster {
  const tokens = text.split(/\s+/).filter((t) => t.length > 0);
  const header = new Map<string, number>();
  let i = 0;
  while (i + 1 < tokens.length && /^[a-z_]+$/i.test(tokens[i]!)) {
    header.set(tokens[i]!.toLowerCase(), Number(tokens[i + 1]));
    i += 2;
  }
  const need = (k: string): number => {
    const v = header.get(k);
    if (v === undefined || !Number.isFinite(v)) throw new Error(`ASCII grid: missing ${k.toUpperCase()}`);
    return v;
  };
  const width = need('ncols');
  const height = need('nrows');
  const dx = header.get('cellsize') ?? need('dx');
  const dyAbs = header.get('cellsize') ?? need('dy');
  const noData = header.get('nodata_value');
  const xll = header.get('xllcorner');
  const yll = header.get('yllcorner');
  const x0 = xll !== undefined ? xll + dx / 2 : need('xllcenter');
  const yBottom = yll !== undefined ? yll + dyAbs / 2 : need('yllcenter');
  const n = width * height;
  if (tokens.length - i < n)
    throw new Error(`ASCII grid: ${tokens.length - i} values for ${width} × ${height} cells`);
  const values = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const v = Number(tokens[i + k]);
    values[k] = !Number.isFinite(v) || v === noData ? NaN : v;
  }
  return { width, height, x0, y0: yBottom + (height - 1) * dyAbs, dx, dy: -dyAbs, values, epsg: null };
}

/** Read the first band of a GeoTIFF. */
export async function readGeoTiff(bytes: ArrayBuffer): Promise<Raster> {
  const tiff = await fromArrayBuffer(bytes);
  const image = await tiff.getImage();
  const width = image.getWidth();
  const height = image.getHeight();
  const [ox, oy] = image.getOrigin() as [number, number];
  const [rx, ry] = image.getResolution() as [number, number];
  const keys = image.getGeoKeys() ?? {};
  // PixelIsPoint (2) puts the origin on the first cell's centre, PixelIsArea on its corner.
  const pointRaster = keys.GTRasterTypeGeoKey === 2;
  const x0 = pointRaster ? ox : ox + rx / 2;
  const y0 = pointRaster ? oy : oy + ry / 2;
  const noData = image.getGDALNoData();
  const [band] = (await image.readRasters({ samples: [0] })) as unknown as ArrayLike<number>[];
  if (!band) throw new Error('GeoTIFF: no raster band');
  const values = new Float32Array(width * height);
  for (let k = 0; k < values.length; k++) {
    const v = band[k]!;
    values[k] = !Number.isFinite(v) || (noData !== null && v === noData) ? NaN : v;
  }
  const epsg = Number(keys.ProjectedCSTypeGeoKey ?? keys.GeographicTypeGeoKey);
  return {
    width,
    height,
    x0,
    y0,
    dx: rx,
    dy: ry,
    values,
    epsg: Number.isInteger(epsg) && epsg > 0 && epsg !== 32767 ? epsg : null,
  };
}

/** Read a DEM file by its name: .tif/.tiff as GeoTIFF, anything else as an ASCII grid. */
export async function readDem(name: string, bytes: ArrayBuffer): Promise<Raster> {
  if (/\.tiff?$/i.test(name)) return readGeoTiff(bytes);
  return readAsciiGrid(new TextDecoder().decode(bytes));
}

/**
 * The height at (x, y) by bilinear interpolation between the four nearest cell
 * centres; at the grid's edge the nearest cells are used. NaN outside the grid or
 * where every neighbour lacks data.
 */
export function sample(r: Raster, x: number, y: number): number {
  const fx = (x - r.x0) / r.dx;
  const fy = (y - r.y0) / r.dy;
  if (fx < -0.5 || fy < -0.5 || fx > r.width - 0.5 || fy > r.height - 0.5) return NaN;
  const cx = Math.min(Math.max(fx, 0), r.width - 1);
  const cy = Math.min(Math.max(fy, 0), r.height - 1);
  const i0 = Math.floor(cx);
  const j0 = Math.floor(cy);
  const i1 = Math.min(i0 + 1, r.width - 1);
  const j1 = Math.min(j0 + 1, r.height - 1);
  const tx = cx - i0;
  const ty = cy - j0;
  const at = (i: number, j: number) => r.values[j * r.width + i]!;
  const corners: [number, number][] = [
    [at(i0, j0), (1 - tx) * (1 - ty)],
    [at(i1, j0), tx * (1 - ty)],
    [at(i0, j1), (1 - tx) * ty],
    [at(i1, j1), tx * ty],
  ];
  // Cells without data drop out and the remaining weights are renormalised.
  let sum = 0;
  let w = 0;
  for (const [v, wt] of corners) {
    if (Number.isNaN(v) || wt === 0) continue;
    sum += v * wt;
    w += wt;
  }
  return w > 0 ? sum / w : NaN;
}

/** The world rectangle a raster covers: [minX, minY, maxX, maxY]. */
export function rasterBounds(r: Raster): [number, number, number, number] {
  const xa = r.x0 - r.dx / 2;
  const xb = r.x0 + (r.width - 0.5) * r.dx;
  const ya = r.y0 - r.dy / 2;
  const yb = r.y0 + (r.height - 0.5) * r.dy;
  return [Math.min(xa, xb), Math.min(ya, yb), Math.max(xa, xb), Math.max(ya, yb)];
}

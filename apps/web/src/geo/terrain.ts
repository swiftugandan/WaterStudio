/**
 * Elevations from online terrain tiles: Terrarium-encoded PNG tiles (AWS Open Data,
 * built by Mapzen from SRTM, GMTED, ETOPO1, NED and other sources). Heights are in
 * metres. Tiles are Web Mercator, 256 pixels square.
 */

export const TERRAIN_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const TERRAIN_ATTRIBUTION =
  'Terrain tiles from AWS Open Data (Mapzen; SRTM, GMTED2010, ETOPO1, USGS NED and others)';

/** At most this many tiles are fetched for one request. */
export const MAX_TILES = 64;
const TILE = 256;

/** A decoded tile: RGBA pixels, 256 × 256. */
export interface TilePixels {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

/** Terrarium's encoding of a height in metres. */
export function terrariumHeight(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Fractional tile coordinates of a longitude and latitude at zoom `z`. */
export function tileCoords(lng: number, lat: number, z: number): [number, number] {
  const n = 2 ** z;
  const x = ((lng + 180) / 360) * n;
  const rad = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return [x, y];
}

/** The deepest zoom (up to 14) at which the points need at most `MAX_TILES` tiles. */
export function terrainZoom(points: readonly [number, number][]): number {
  for (let z = 14; z > 0; z--) {
    const tiles = new Set<string>();
    for (const [lng, lat] of points) {
      const [x, y] = tileCoords(lng, lat, z);
      tiles.add(`${Math.floor(x)}/${Math.floor(y)}`);
      if (tiles.size > MAX_TILES) break;
    }
    if (tiles.size <= MAX_TILES) return z;
  }
  return 0;
}

/**
 * Heights in metres at each longitude and latitude, by bilinear interpolation between
 * pixel centres of the tiles `fetchTile` returns (NaN where a tile is missing).
 */
export async function sampleTerrain(
  points: readonly [number, number][],
  fetchTile: (z: number, x: number, y: number) => Promise<TilePixels | null>,
): Promise<{ heights: number[]; zoom: number; tiles: number }> {
  const z = terrainZoom(points);
  const n = 2 ** z;
  const cache = new Map<string, Promise<TilePixels | null>>();
  const tile = (tx: number, ty: number) => {
    const x = ((tx % n) + n) % n;
    const y = Math.min(Math.max(ty, 0), n - 1);
    const key = `${x}/${y}`;
    let p = cache.get(key);
    if (!p) {
      p = fetchTile(z, x, y).catch(() => null);
      cache.set(key, p);
    }
    return p;
  };
  const pixel = async (gx: number, gy: number): Promise<number> => {
    const t = await tile(Math.floor(gx / TILE), Math.floor(gy / TILE));
    if (!t) return NaN;
    const px = Math.min(Math.max(gx - Math.floor(gx / TILE) * TILE, 0), t.width - 1);
    const py = Math.min(Math.max(gy - Math.floor(gy / TILE) * TILE, 0), t.height - 1);
    const i = (py * t.width + px) * 4;
    return terrariumHeight(t.data[i]!, t.data[i + 1]!, t.data[i + 2]!);
  };
  const heights = await Promise.all(
    points.map(async ([lng, lat]) => {
      const [x, y] = tileCoords(lng, lat, z);
      // Global pixel coordinates, relative to pixel centres.
      const fx = x * TILE - 0.5;
      const fy = y * TILE - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const [a, b, c, d] = await Promise.all([
        pixel(x0, y0),
        pixel(x0 + 1, y0),
        pixel(x0, y0 + 1),
        pixel(x0 + 1, y0 + 1),
      ]);
      return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }),
  );
  return { heights, zoom: z, tiles: cache.size };
}

/** Fetch and decode one tile in the browser. */
export async function fetchTerrainTile(
  z: number,
  x: number,
  y: number,
  template = TERRAIN_TILES,
): Promise<TilePixels | null> {
  const url = template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
  const res = await fetch(url);
  if (!res.ok) return null;
  const bitmap = await createImageBitmap(await res.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0);
  const img = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { data: img.data, width: img.width, height: img.height };
}

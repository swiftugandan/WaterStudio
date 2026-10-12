import { describe, expect, it } from 'vitest';
import { sampleTerrain, terrainZoom, terrariumHeight, tileCoords, type TilePixels } from './terrain.ts';

/** A tile whose every pixel encodes `h` metres. */
function flat(h: number): TilePixels {
  const v = h + 32768;
  const data = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.floor(v / 256);
    data[i + 1] = Math.floor(v % 256);
    data[i + 2] = Math.round((v % 1) * 256);
    data[i + 3] = 255;
  }
  return { data, width: 256, height: 256 };
}

describe('terrain tiles', () => {
  it('decodes Terrarium heights', () => {
    expect(terrariumHeight(128, 0, 0)).toBe(0);
    expect(terrariumHeight(128, 100, 128)).toBe(100.5);
    expect(terrariumHeight(127, 255, 0)).toBe(-1);
  });

  it('places points on Web Mercator tiles', () => {
    expect(tileCoords(0, 0, 1)).toEqual([1, 1]);
    const [x, y] = tileCoords(-180, 85.0511, 3);
    expect(x).toBe(0);
    expect(y).toBeCloseTo(0, 3);
  });

  it('uses the deepest zoom that keeps the tile count small', () => {
    expect(terrainZoom([[10, 50]])).toBe(14);
    const spread: [number, number][] = [];
    for (let i = 0; i < 20; i++) for (let j = 0; j < 20; j++) spread.push([10 + i * 0.05, 50 + j * 0.05]);
    const z = terrainZoom(spread);
    expect(z).toBeLessThan(14);
    expect(z).toBeGreaterThan(6);
  });

  it('samples heights from the tiles it fetches once each', async () => {
    const asked: string[] = [];
    const { heights, tiles } = await sampleTerrain(
      [
        [10, 50],
        [10.0001, 50.0001],
      ],
      (z, x, y) => {
        asked.push(`${z}/${x}/${y}`);
        return Promise.resolve(flat(321.25));
      },
    );
    expect(heights).toEqual([321.25, 321.25]);
    expect(tiles).toBe(new Set(asked).size);
    const missing = await sampleTerrain([[10, 50]], () => Promise.resolve(null));
    expect(missing.heights[0]).toBeNaN();
  });
});

/**
 * The symbol atlas: the engineering symbol masters rasterised once per theme into one
 * bitmap, for the WebGPU and Canvas 2D backends alike. Built on the main thread (SVG
 * decoding needs the DOM) and transferred to the render worker.
 */

import { symbolSvg, type SymbolId } from '@waterstudio/symbols';
import type { Theme } from './style.ts';

export const ATLAS_SYMBOLS = [
  'reservoir',
  'tank',
  'check-valve',
  'pump',
  'valve-prv',
  'valve-psv',
  'valve-pbv',
  'valve-fcv',
  'valve-tcv',
  'valve-gpv',
  'valve-pcv',
] as const satisfies readonly SymbolId[];

export const ATLAS_CELL = 64;

/** Two rows: symbols in the theme's node colour, then in the selection colour. */
export interface Atlas {
  bitmap: ImageBitmap;
  cell: number;
  columns: number;
}

export function atlasIndex(id: (typeof ATLAS_SYMBOLS)[number]): number {
  return ATLAS_SYMBOLS.indexOf(id);
}

function paint(svg: string, fg: string, bg: string): string {
  return svg
    .replace('width="24" height="24"', `width="${ATLAS_CELL}" height="${ATLAS_CELL}"`)
    .replaceAll('currentColor', fg)
    .replaceAll('#ffffff', bg);
}

async function load(svg: string): Promise<ImageBitmap> {
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  // createImageBitmap does not decode SVG in every browser; go through an <img>.
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image(ATLAS_CELL, ATLAS_CELL);
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function buildAtlas(theme: Theme): Promise<Atlas> {
  const columns = ATLAS_SYMBOLS.length;
  const canvas = new OffscreenCanvas(columns * ATLAS_CELL, 2 * ATLAS_CELL);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2D context for the symbol atlas');
  const rows = [theme.node, theme.selection];
  const images = await Promise.all(
    rows.flatMap((fg) => ATLAS_SYMBOLS.map((id) => load(paint(symbolSvg(id), fg, theme.background)))),
  );
  images.forEach((img, i) => {
    ctx.drawImage(img, (i % columns) * ATLAS_CELL, Math.floor(i / columns) * ATLAS_CELL);
    img.close();
  });
  return { bitmap: canvas.transferToImageBitmap(), cell: ATLAS_CELL, columns };
}

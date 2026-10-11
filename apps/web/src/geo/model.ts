/** Where a model's coordinate system lives: a `CRS` line in [BACKDROP]. */

import { keywordMatches, sectionGet, type Document, type model } from '@waterstudio/core';
import { looksGeographic, resolveCrs, type Crs } from './crs.ts';

/** The CRS text a model records, or null. */
export function crsText(backdrop: model.KeywordSection): string | null {
  const t = sectionGet(backdrop, ['CRS']);
  return t && t.length > 0 ? t.join(' ') : null;
}

/** [BACKDROP] with the CRS line replaced (or removed with null). */
export function withCrs(backdrop: model.KeywordSection, text: string | null): model.KeywordSection {
  const lines = backdrop.lines.filter((l) => !(l.tokens[0] && keywordMatches(l.tokens[0], 'CRS')));
  if (text) lines.push({ tokens: ['CRS', ...text.trim().split(/\s+/)], comment: null });
  return { lines };
}

export interface ModelCrs {
  crs: Crs;
  /** True when no CRS is recorded but the coordinates look like longitude and latitude. */
  implicit: boolean;
}

/** The model's coordinate system, if it has one or plainly uses longitude and latitude. */
export function modelCrs(doc: Document): ModelCrs | null {
  const text = crsText(doc.data.backdrop);
  if (text) {
    const crs = resolveCrs(text);
    return crs ? { crs, implicit: false } : null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (const h of doc.nodeHandles()) {
    const x = doc.num(h, 'x');
    const y = doc.num(h, 'y');
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    n++;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  if (n < 2 || !looksGeographic(minX, minY, maxX, maxY)) return null;
  const crs = resolveCrs('EPSG:4326');
  return crs ? { crs, implicit: true } : null;
}

export interface BackdropPlacement {
  /** World rectangle the image covers: lower left and upper right. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where EPANET's [BACKDROP] puts the image: DIMENSIONS shifted by OFFSET. */
export function backdropPlacement(backdrop: model.KeywordSection): BackdropPlacement | null {
  const d = sectionGet(backdrop, ['DIMENSIONS'])?.map(Number);
  if (!d || d.length < 4 || !d.slice(0, 4).every(Number.isFinite)) return null;
  const o = sectionGet(backdrop, ['OFFSET'])?.map(Number) ?? [];
  const dx = Number.isFinite(o[0]) ? o[0]! : 0;
  const dy = Number.isFinite(o[1]) ? o[1]! : 0;
  return { x1: d[0]! + dx, y1: d[1]! + dy, x2: d[2]! + dx, y2: d[3]! + dy };
}

/** [BACKDROP] with a keyword's line replaced by `tokens` (or removed with null). */
export function withBackdropLine(
  backdrop: model.KeywordSection,
  keyword: string,
  tokens: string[] | null,
): model.KeywordSection {
  const lines = backdrop.lines.filter((l) => !(l.tokens[0] && keywordMatches(l.tokens[0], keyword)));
  if (tokens) lines.push({ tokens: [keyword, ...tokens], comment: null });
  return { lines };
}

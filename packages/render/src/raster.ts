/**
 * A small rasteriser for the Canvas 2D backend's overview: when links are a few pixels
 * long, stroking tens of thousands of them through Path2D costs hundreds of
 * milliseconds on a CPU canvas, while writing their pixels straight into an image
 * costs a few. Lines are square-brushed and not anti-aliased, which is invisible at
 * that scale.
 */

/** A `#rgb` or `#rrggbb` colour as a pixel of an RGBA image viewed as little-endian u32. */
export function packColor(hex: string): number | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const v = parseInt(h, 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  return ((255 << 24) | (b << 16) | (g << 8) | r) >>> 0;
}

/** A pixel rectangle [x0, y0, x1, y1), half-open. */
export type PixelRect = [number, number, number, number];

/**
 * Draw a line `width` pixels wide from (x0, y0) to (x1, y1), in pixel coordinates,
 * into an image of `w` by `h` pixels, touching only pixels inside `clipBox` (the whole
 * image by default).
 */
export function strokeLine(
  buf: Uint32Array,
  w: number,
  h: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  width: number,
  color: number,
  clipBox: PixelRect = [0, 0, w, h],
): void {
  // Clip to the clip box grown by the brush (Liang–Barsky), so long lines cost what shows.
  const [cx0, cy0, cx1, cy1] = clipBox;
  const m = width;
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const inside =
    Math.min(x0, x1) >= cx0 - m &&
    Math.max(x0, x1) <= cx1 + m &&
    Math.min(y0, y1) >= cy0 - m &&
    Math.max(y0, y1) <= cy1 + m;
  if (!inside) {
    const ps = [-dx, dx, -dy, dy];
    const qs = [x0 - cx0 + m, cx1 + m - x0, y0 - cy0 + m, cy1 + m - y0];
    for (let e = 0; e < 4; e++) {
      const p = ps[e]!;
      const q = qs[e]!;
      if (p === 0) {
        if (q < 0) return;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return;
        if (r < t1) t1 = r;
      }
    }
  }
  let ax = Math.round(x0 + t0 * dx);
  let ay = Math.round(y0 + t0 * dy);
  const bx = Math.round(x0 + t1 * dx);
  const by = Math.round(y0 + t1 * dy);
  const o = (width - 1) >> 1;
  const sx = ax < bx ? 1 : -1;
  const sy = ay < by ? 1 : -1;
  const ex = Math.abs(bx - ax);
  const ey = -Math.abs(by - ay);
  let err = ex + ey;
  for (;;) {
    // The brush: a width × width square at (ax, ay).
    const xa = Math.max(cx0, ax - o);
    const xb = Math.min(cx1 - 1, ax - o + width - 1);
    if (xa <= xb) {
      const ya = Math.max(cy0, ay - o);
      const yb = Math.min(cy1 - 1, ay - o + width - 1);
      for (let y = ya; y <= yb; y++) {
        const row = y * w;
        for (let x = xa; x <= xb; x++) buf[row + x] = color;
      }
    }
    if (ax === bx && ay === by) break;
    const e2 = 2 * err;
    if (e2 >= ey) {
      err += ey;
      ax += sx;
    }
    if (e2 <= ex) {
      err += ex;
      ay += sy;
    }
  }
}

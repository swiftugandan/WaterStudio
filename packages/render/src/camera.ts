/**
 * The 2D camera. World coordinates are the model's map coordinates (y up), kept in
 * f64; screen coordinates are CSS pixels from the top left. The camera is the single
 * source of truth for the view; the basemap follows it.
 */

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface CameraState {
  /** World point at the centre of the view. */
  cx: number;
  cy: number;
  /** CSS pixels per world unit. */
  scale: number;
  /** Viewport size in CSS pixels. */
  width: number;
  height: number;
}

export const MIN_SCALE = 1e-9;
export const MAX_SCALE = 1e9;

export class Camera implements CameraState {
  cx = 0;
  cy = 0;
  scale = 1;
  width = 1;
  height = 1;

  state(): CameraState {
    return { cx: this.cx, cy: this.cy, scale: this.scale, width: this.width, height: this.height };
  }

  set(s: Partial<CameraState>): void {
    Object.assign(this, s);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale));
  }

  resize(width: number, height: number): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) * this.scale + this.width / 2, this.height / 2 - (y - this.cy) * this.scale];
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [(sx - this.width / 2) / this.scale + this.cx, (this.height / 2 - sy) / this.scale + this.cy];
  }

  /** The world rectangle in view. */
  viewBounds(): Bounds {
    const hw = this.width / 2 / this.scale;
    const hh = this.height / 2 / this.scale;
    return { minX: this.cx - hw, minY: this.cy - hh, maxX: this.cx + hw, maxY: this.cy + hh };
  }

  /** Pan by a screen offset in CSS pixels. */
  panBy(dx: number, dy: number): void {
    this.cx -= dx / this.scale;
    this.cy += dy / this.scale;
  }

  /** Zoom by a factor, keeping the world point under the screen point fixed. */
  zoomAt(factor: number, sx: number, sy: number): void {
    const [wx, wy] = this.toWorld(sx, sy);
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
    const [nx, ny] = this.toWorld(sx, sy);
    this.cx += wx - nx;
    this.cy += wy - ny;
  }

  /** Fit a world rectangle into the view with a margin in CSS pixels. */
  fit(b: Bounds, margin = 24): void {
    const w = Math.max(b.maxX - b.minX, 1e-6);
    const h = Math.max(b.maxY - b.minY, 1e-6);
    const sx = Math.max(1, this.width - 2 * margin) / w;
    const sy = Math.max(1, this.height - 2 * margin) / h;
    this.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(sx, sy)));
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
  }
}

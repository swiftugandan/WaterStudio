/**
 * A uniform grid over scene items (segments or points) for fast rectangle queries in
 * the render worker, where rebuilding per frame must stay cheap.
 */

import type { Bounds } from './camera.ts';

export class Grid {
  private readonly cells: Uint32Array;
  private readonly starts: Uint32Array;
  private readonly cols: number;
  private readonly rows: number;
  private readonly x0: number;
  private readonly y0: number;
  private readonly size: number;
  private readonly stamp: Uint32Array;
  private mark = 0;
  /** Items that moved since the grid was built: visited by every query. */
  private readonly extra: number[] = [];

  /** `box(i)` writes item i's [minX, minY, maxX, maxY] (NaN to skip). */
  constructor(count: number, bounds: Bounds, box: (i: number, out: Float64Array) => void) {
    const w = Math.max(bounds.maxX - bounds.minX, 1e-9);
    const h = Math.max(bounds.maxY - bounds.minY, 1e-9);
    const target = Math.max(1, Math.sqrt(count / 4));
    this.size = Math.max(w, h) / Math.min(512, Math.max(1, Math.ceil(target)));
    this.cols = Math.max(1, Math.ceil(w / this.size) + 1);
    this.rows = Math.max(1, Math.ceil(h / this.size) + 1);
    this.x0 = bounds.minX;
    this.y0 = bounds.minY;
    this.stamp = new Uint32Array(count);
    const counts = new Uint32Array(this.cols * this.rows + 1);
    const b = new Float64Array(4);
    const visit = (i: number, fn: (cell: number) => void) => {
      box(i, b);
      if (Number.isNaN(b[0]!)) return;
      const c0 = this.col(b[0]!);
      const c1 = this.col(b[2]!);
      const r0 = this.row(b[1]!);
      const r1 = this.row(b[3]!);
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn(r * this.cols + c);
    };
    for (let i = 0; i < count; i++) visit(i, (cell) => counts[cell + 1]!++);
    for (let k = 1; k < counts.length; k++) counts[k]! += counts[k - 1]!;
    this.starts = counts.slice();
    this.cells = new Uint32Array(counts[counts.length - 1]!);
    const fill = counts.slice();
    for (let i = 0; i < count; i++) visit(i, (cell) => (this.cells[fill[cell]!++] = i));
  }

  private col(x: number): number {
    return Math.max(0, Math.min(this.cols - 1, Math.floor((x - this.x0) / this.size)));
  }

  private row(y: number): number {
    return Math.max(0, Math.min(this.rows - 1, Math.floor((y - this.y0) / this.size)));
  }

  /** Items that moved and are checked by every query. */
  get moved(): number {
    return this.extra.length;
  }

  /** Item i moved: queries visit it wherever they look (its old cells still list it too). */
  include(i: number): void {
    this.extra.push(i);
  }

  /** Call `fn` once for each item whose cell overlaps the rectangle. */
  query(minX: number, minY: number, maxX: number, maxY: number, fn: (i: number) => void): void {
    this.mark++;
    if (this.mark === 0xffffffff) {
      this.stamp.fill(0);
      this.mark = 1;
    }
    for (const i of this.extra) {
      if (this.stamp[i] !== this.mark) {
        this.stamp[i] = this.mark;
        fn(i);
      }
    }
    const c0 = this.col(minX);
    const c1 = this.col(maxX);
    const r0 = this.row(minY);
    const r1 = this.row(maxY);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * this.cols + c;
        for (let k = this.starts[cell]!; k < this.starts[cell + 1]!; k++) {
          const i = this.cells[k]!;
          if (this.stamp[i] !== this.mark) {
            this.stamp[i] = this.mark;
            fn(i);
          }
        }
      }
    }
  }
}

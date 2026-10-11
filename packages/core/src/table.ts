/**
 * A columnar table: one growable array per field, rows addressed by index. Rows are
 * never moved; deleting a row marks it dead so that row order (which is EPANET's
 * element order) survives deletion and undo.
 */

export type ColumnType = 'f64' | 'u32' | 'u8' | 'str' | 'any';

export type ColumnValue<T extends ColumnType> = T extends 'str'
  ? string | null
  : T extends 'any'
    ? unknown
    : number;

type Storage = Float64Array | Uint32Array | Uint8Array | (string | null)[] | unknown[];

function allocate(type: ColumnType, capacity: number): Storage {
  switch (type) {
    case 'f64':
      return new Float64Array(capacity);
    case 'u32':
      return new Uint32Array(capacity);
    case 'u8':
      return new Uint8Array(capacity);
    case 'str':
    case 'any':
      return [];
  }
}

export class Column<T extends ColumnType = ColumnType> {
  data: Storage;
  readonly name: string;
  readonly type: T;
  readonly fallback: ColumnValue<T>;

  constructor(name: string, type: T, fallback: ColumnValue<T>, capacity: number) {
    this.name = name;
    this.type = type;
    this.fallback = fallback;
    this.data = allocate(type, capacity);
  }

  get(row: number): ColumnValue<T> {
    const v = this.data[row];
    return (v === undefined ? this.fallback : v) as ColumnValue<T>;
  }

  set(row: number, value: ColumnValue<T>): void {
    (this.data as unknown[])[row] = value;
  }

  grow(capacity: number): void {
    if (Array.isArray(this.data)) return;
    const next = allocate(this.type, capacity) as Float64Array | Uint32Array | Uint8Array;
    next.set(this.data);
    this.data = next;
  }
}

export interface ColumnSpec {
  name: string;
  type: ColumnType;
  /** Value of a new row's field when none is given. NaN means "not set" for optional numbers. */
  fallback: unknown;
}

export class Table {
  readonly columns = new Map<string, Column>();
  private capacity: number;
  /** Rows in use, alive or dead. */
  length = 0;
  alive = new Uint8Array(0);
  handles = new Uint32Array(0);
  private live = 0;

  constructor(specs: readonly ColumnSpec[], capacity = 64) {
    this.capacity = capacity;
    this.alive = new Uint8Array(capacity);
    this.handles = new Uint32Array(capacity);
    for (const s of specs) {
      this.columns.set(s.name, new Column(s.name, s.type, s.fallback, capacity));
    }
  }

  get liveCount(): number {
    return this.live;
  }

  column(name: string): Column {
    const c = this.columns.get(name);
    if (!c) throw new Error(`no column ${name}`);
    return c;
  }

  /** Append a row with fallbacks; returns its index. */
  append(handle: number): number {
    if (this.length === this.capacity) this.reserve(this.capacity * 2);
    const row = this.length++;
    for (const c of this.columns.values()) c.set(row, c.fallback);
    this.handles[row] = handle;
    this.alive[row] = 1;
    this.live++;
    return row;
  }

  reserve(capacity: number): void {
    if (capacity <= this.capacity) return;
    this.capacity = capacity;
    const alive = new Uint8Array(capacity);
    alive.set(this.alive);
    this.alive = alive;
    const handles = new Uint32Array(capacity);
    handles.set(this.handles);
    this.handles = handles;
    for (const c of this.columns.values()) c.grow(capacity);
  }

  kill(row: number): void {
    if (this.alive[row] === 1) {
      this.alive[row] = 0;
      this.live--;
    }
  }

  revive(row: number): void {
    if (this.alive[row] === 0) {
      this.alive[row] = 1;
      this.live++;
    }
  }

  isAlive(row: number): boolean {
    return this.alive[row] === 1;
  }

  /** Live row indices in order. */
  *rows(): IterableIterator<number> {
    for (let r = 0; r < this.length; r++) if (this.alive[r] === 1) yield r;
  }

  /** All field values of a row, for snapshots and undo. */
  readRow(row: number): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, c] of this.columns) {
      const v = c.get(row);
      out[name] = Array.isArray(v) ? structuredClone(v) : v;
    }
    return out;
  }

  writeRow(row: number, values: Record<string, unknown>): void {
    for (const [name, v] of Object.entries(values)) {
      const c = this.columns.get(name);
      if (c) c.set(row, v);
    }
  }
}

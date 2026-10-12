/**
 * The network document: a node table and a link table (all kinds in each, in EPANET's
 * element order) plus document-level data (patterns, curves, controls, rules and the
 * settings sections), all changed only through the operations in this file.
 *
 * Every element has a stable u32 handle that is never reused, so selections, undo and
 * agent references survive renames and deletions.
 */

import type { Control, Curve, KeywordSection, Label, Pattern, RawSection, Rule } from './generated/model.ts';
import {
  LINK_COLUMNS,
  LINK_KINDS,
  NODE_COLUMNS,
  NODE_KINDS,
  type LinkKind,
  type NodeKind,
} from './schema.ts';
import { Table } from './table.ts';

/** Document-level data, kept as values and replaced whole by `doc` operations. */
export interface DocData {
  title: string[];
  patterns: Pattern[];
  curves: Curve[];
  controls: Control[];
  rules: Rule[];
  options: KeywordSection;
  times: KeywordSection;
  report: KeywordSection;
  energy: KeywordSection;
  reactions: KeywordSection;
  backdrop: KeywordSection;
  labels: Label[];
  extraSections: RawSection[];
  /** Isolation valves at pipe ends (WaterStudio's own; EPANET files have no place for them). */
  isolationValves: IsolationValve[];
  /** The EPANET-MSX input that goes with the network, if any (its own file beside the .inp). */
  msx: MsxInput | null;
}

/** An EPANET-MSX input file: its name and text. */
export interface MsxInput {
  name: string;
  text: string;
}

/** An isolation valve on a link next to one of its end nodes. */
export interface IsolationValve {
  link: string;
  node: string;
}

export type DocKey = keyof DocData;

export function emptyDocData(): DocData {
  const section = (): KeywordSection => ({ lines: [] });
  return {
    title: [],
    patterns: [],
    curves: [],
    controls: [],
    rules: [],
    options: section(),
    times: section(),
    report: section(),
    energy: section(),
    reactions: section(),
    backdrop: section(),
    labels: [],
    extraSections: [],
    isolationValves: [],
    msx: null,
  };
}

export type TableName = 'node' | 'link';

/** One reversible change. `p` holds the previous value so the inverse is exact. */
export type Op =
  | { t: 'set'; h: number; f: string; v: unknown; p: unknown }
  | { t: 'add'; h: number; table: TableName; row: number; values: Record<string, unknown> }
  | { t: 'del'; h: number; table: TableName; row: number; values: Record<string, unknown> }
  | { t: 'doc'; k: DocKey; v: unknown; p: unknown };

interface Place {
  table: TableName;
  row: number;
}

export class Document {
  readonly nodes = new Table(NODE_COLUMNS, 256);
  readonly links = new Table(LINK_COLUMNS, 256);
  data: DocData = emptyDocData();
  private readonly places = new Map<number, Place>();
  private readonly nodeIds = new Map<string, number>();
  private readonly linkIds = new Map<string, number>();
  private nextHandle = 1;

  /** Allocate a handle (never reused). */
  newHandle(): number {
    return this.nextHandle++;
  }

  /** An independent copy with the same handles, elements in the same order (agent drafts). */
  clone(): Document {
    const d = new Document();
    for (const table of ['node', 'link'] as const) {
      const t = this.table(table);
      for (const r of t.rows()) {
        d.apply({ t: 'add', h: t.handles[r]!, table, row: -1, values: structuredClone(t.readRow(r)) });
      }
    }
    d.data = structuredClone(this.data);
    d.nextHandle = this.nextHandle;
    return d;
  }

  has(h: number): boolean {
    const p = this.places.get(h);
    return p !== undefined && this.table(p.table).isAlive(p.row);
  }

  place(h: number): Place {
    const p = this.places.get(h);
    if (!p) throw new Error(`unknown element ${h}`);
    return p;
  }

  table(t: TableName): Table {
    return t === 'node' ? this.nodes : this.links;
  }

  isNode(h: number): boolean {
    return this.places.get(h)?.table === 'node';
  }

  isLink(h: number): boolean {
    return this.places.get(h)?.table === 'link';
  }

  nodeKind(h: number): NodeKind {
    const p = this.place(h);
    return NODE_KINDS[this.nodes.column('kind').get(p.row) as number] ?? 'junction';
  }

  linkKind(h: number): LinkKind {
    const p = this.place(h);
    return LINK_KINDS[this.links.column('kind').get(p.row) as number] ?? 'pipe';
  }

  kind(h: number): NodeKind | LinkKind {
    return this.isNode(h) ? this.nodeKind(h) : this.linkKind(h);
  }

  get(h: number, field: string): unknown {
    const p = this.place(h);
    return this.table(p.table).column(field).get(p.row);
  }

  num(h: number, field: string): number {
    return this.get(h, field) as number;
  }

  str(h: number, field: string): string | null {
    return this.get(h, field) as string | null;
  }

  id(h: number): string {
    return this.get(h, 'id') as string;
  }

  findNode(id: string): number | undefined {
    return this.nodeIds.get(id);
  }

  findLink(id: string): number | undefined {
    return this.linkIds.get(id);
  }

  /** Live node handles in element order. */
  *nodeHandles(): IterableIterator<number> {
    const t = this.nodes;
    for (let r = 0; r < t.length; r++) if (t.alive[r] === 1) yield t.handles[r]!;
  }

  *linkHandles(): IterableIterator<number> {
    const t = this.links;
    for (let r = 0; r < t.length; r++) if (t.alive[r] === 1) yield t.handles[r]!;
  }

  /** Links touching a node. */
  linksAt(node: number): number[] {
    const out: number[] = [];
    const t = this.links;
    const from = t.column('from').data as Uint32Array;
    const to = t.column('to').data as Uint32Array;
    for (let r = 0; r < t.length; r++) {
      if (t.alive[r] === 1 && (from[r] === node || to[r] === node)) out.push(t.handles[r]!);
    }
    return out;
  }

  /** Apply one operation. Returns its inverse. */
  apply(op: Op): Op {
    switch (op.t) {
      case 'set': {
        const p = this.place(op.h);
        const col = this.table(p.table).column(op.f);
        const prev = col.get(p.row);
        if (op.f === 'id') this.reindex(p.table, prev as string, op.v as string, op.h);
        col.set(p.row, op.v);
        return { t: 'set', h: op.h, f: op.f, v: prev, p: op.v };
      }
      case 'add': {
        const t = this.table(op.table);
        let row = op.row;
        if (row < 0 || row >= t.length) {
          row = t.append(op.h);
        } else {
          t.revive(row);
          t.handles[row] = op.h;
        }
        t.writeRow(row, op.values);
        this.places.set(op.h, { table: op.table, row });
        this.index(op.table).set(t.column('id').get(row) as string, op.h);
        if (op.h >= this.nextHandle) this.nextHandle = op.h + 1;
        return { t: 'del', h: op.h, table: op.table, row, values: op.values };
      }
      case 'del': {
        const p = this.place(op.h);
        const t = this.table(p.table);
        const values = t.readRow(p.row);
        t.kill(p.row);
        const id = values['id'] as string;
        if (this.index(p.table).get(id) === op.h) this.index(p.table).delete(id);
        return { t: 'add', h: op.h, table: p.table, row: p.row, values };
      }
      case 'doc': {
        const prev = this.data[op.k];
        (this.data as unknown as Record<string, unknown>)[op.k] = op.v;
        return { t: 'doc', k: op.k, v: prev, p: op.v };
      }
    }
  }

  private index(t: TableName): Map<string, number> {
    return t === 'node' ? this.nodeIds : this.linkIds;
  }

  private reindex(t: TableName, prev: string, next: string, h: number): void {
    const idx = this.index(t);
    if (idx.get(prev) === h) idx.delete(prev);
    idx.set(next, h);
  }
}

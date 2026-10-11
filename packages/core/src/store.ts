/**
 * The store: the only way to change a document. Every change is a transaction of
 * operations recorded with the values they replaced, so undo and redo are exact.
 * A drag or a typed field coalesces into one undo step.
 */

import { Document, type DocData, type DocKey, type Op, type TableName } from './document.ts';
import { LINK_KINDS, NODE_KINDS, type LinkKind, type NodeKind } from './schema.ts';

export interface Transaction {
  label: string;
  ops: Op[];
  /** Transactions with the same key, made in quick succession, merge into one step. */
  coalesce?: string;
  time: number;
}

export type ChangeSource = 'edit' | 'undo' | 'redo' | 'load';

/** What a commit changed, for listeners that update incrementally. */
export interface Change {
  rev: number;
  source: ChangeSource;
  label: string;
  /** Elements were added or removed, or a link's end nodes or a kind changed. */
  structural: boolean;
  /** Elements whose fields changed (including added and removed ones). */
  elements: Set<number>;
  /** Fields that changed on any element. */
  fields: Set<string>;
  /** Document-level keys that changed. */
  doc: Set<DocKey>;
  /** The operations as applied: each `v` is the value now, `p` the one it replaced. */
  ops: readonly Op[];
}

export type Listener = (change: Change) => void;

const COALESCE_MS = 1000;
const STRUCTURAL_FIELDS = new Set(['from', 'to', 'kind']);

/** Builds a transaction; handed to the callback of `Store.transact`. */
export class Tx {
  readonly ops: Op[] = [];
  private readonly doc: Document;

  constructor(doc: Document) {
    this.doc = doc;
  }

  private push(op: Op): void {
    // Apply now so later reads in the same transaction see it; the inverse is not needed here.
    this.doc.apply(op);
    this.ops.push(op);
  }

  set(h: number, field: string, value: unknown): void {
    const prev = this.doc.get(h, field);
    if (Object.is(prev, value)) return;
    this.push({ t: 'set', h, f: field, v: value, p: prev });
  }

  addNode(kind: NodeKind, values: Record<string, unknown>): number {
    return this.add('node', { ...values, kind: NODE_KINDS.indexOf(kind) });
  }

  addLink(kind: LinkKind, values: Record<string, unknown>): number {
    return this.add('link', { ...values, kind: LINK_KINDS.indexOf(kind) });
  }

  private add(table: TableName, values: Record<string, unknown>): number {
    const h = this.doc.newHandle();
    const op: Op = { t: 'add', h, table, row: -1, values };
    const inverse = this.doc.apply(op);
    // Record the row that was assigned, so redo revives the same row.
    if (inverse.t === 'del') op.row = inverse.row;
    this.ops.push(op);
    return h;
  }

  delete(h: number): void {
    const p = this.doc.place(h);
    const values = this.doc.table(p.table).readRow(p.row);
    this.push({ t: 'del', h, table: p.table, row: p.row, values });
  }

  setDoc<K extends DocKey>(key: K, value: DocData[K]): void {
    this.push({ t: 'doc', k: key, v: value, p: this.doc.data[key] });
  }
}

export class Store {
  readonly doc: Document;
  private undoStack: Transaction[] = [];
  private redoStack: Transaction[] = [];
  private listeners = new Set<Listener>();
  private revision = 0;
  /** Time source; replaceable in tests. */
  now: () => number = () => Date.now();

  constructor(doc = new Document()) {
    this.doc = doc;
  }

  get rev(): number {
    return this.revision;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | undefined {
    return this.undoStack.at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.redoStack.at(-1)?.label;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Run `fn` as one transaction. If it throws, everything it did is rolled back and
   * the error is rethrown. Returns what `fn` returns.
   */
  transact<T>(label: string, fn: (tx: Tx) => T, options: { coalesce?: string } = {}): T {
    const tx = new Tx(this.doc);
    let result: T;
    try {
      result = fn(tx);
    } catch (e) {
      this.rollback(tx.ops);
      throw e;
    }
    if (tx.ops.length === 0) return result;
    const time = this.now();
    const last = this.undoStack.at(-1);
    if (
      options.coalesce !== undefined &&
      last?.coalesce === options.coalesce &&
      time - last.time < COALESCE_MS
    ) {
      last.ops.push(...tx.ops);
      last.time = time;
    } else {
      this.undoStack.push({
        label,
        ops: tx.ops,
        time,
        ...(options.coalesce ? { coalesce: options.coalesce } : {}),
      });
    }
    this.redoStack = [];
    this.emit('edit', label, tx.ops);
    return result;
  }

  undo(): boolean {
    const t = this.undoStack.pop();
    if (!t) return false;
    const inverses = this.applyInverse(t.ops);
    this.redoStack.push(t);
    this.emit('undo', t.label, inverses);
    return true;
  }

  redo(): boolean {
    const t = this.redoStack.pop();
    if (!t) return false;
    for (const op of t.ops) this.doc.apply(op);
    this.undoStack.push({ ...t, time: 0 }); // a redone step never coalesces
    this.emit('redo', t.label, t.ops);
    return true;
  }

  /** Replace history-free state wholesale (opening a file). Clears undo and redo. */
  load(fill: (tx: Tx) => void, label = 'Open'): void {
    const tx = new Tx(this.doc);
    fill(tx);
    this.undoStack = [];
    this.redoStack = [];
    this.emit('load', label, tx.ops);
  }

  private applyInverse(ops: Op[]): Op[] {
    const out: Op[] = [];
    for (let i = ops.length - 1; i >= 0; i--) {
      // Apply the inverse and report it as applied, re-derived against the current state.
      out.push(invert(this.doc.apply(invert(ops[i]!))));
    }
    return out;
  }

  private rollback(ops: Op[]): void {
    for (let i = ops.length - 1; i >= 0; i--) this.doc.apply(invert(ops[i]!));
  }

  private emit(source: ChangeSource, label: string, ops: Op[]): void {
    this.revision++;
    const change: Change = {
      rev: this.revision,
      source,
      label,
      structural: false,
      elements: new Set(),
      fields: new Set(),
      doc: new Set(),
      ops,
    };
    for (const op of ops) {
      if (op.t === 'doc') {
        change.doc.add(op.k);
        continue;
      }
      change.elements.add(op.h);
      if (op.t === 'set') {
        change.fields.add(op.f);
        if (STRUCTURAL_FIELDS.has(op.f)) change.structural = true;
      } else {
        change.structural = true;
      }
    }
    for (const fn of this.listeners) fn(change);
  }
}

/** The inverse of an operation as recorded (its `p` is the value it replaced). */
export function invert(op: Op): Op {
  switch (op.t) {
    case 'set':
      return { t: 'set', h: op.h, f: op.f, v: op.p, p: op.v };
    case 'add':
      return { t: 'del', h: op.h, table: op.table, row: op.row, values: op.values };
    case 'del':
      return { t: 'add', h: op.h, table: op.table, row: op.row, values: op.values };
    case 'doc':
      return { t: 'doc', k: op.k, v: op.p, p: op.v };
  }
}

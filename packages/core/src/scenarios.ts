/**
 * Scenarios: named alternatives of one network. A scenario overrides element
 * properties (demands, diameters, settings, statuses, initial quality …) and
 * document data (patterns, curves, controls, rules, options and times) of its parent,
 * or of the base network when it has none, so scenarios inherit as a tree.
 *
 * The network's structure and geometry are shared: adding or deleting elements, IDs,
 * coordinates, vertices and end nodes change the base for every scenario.
 *
 * While a scenario is active, edits to properties are recorded as its overrides;
 * undo and redo keep them in step. Switching scenarios rewrites only the overridden
 * values and starts a fresh undo history.
 */

import type { DocKey, Op } from './document.ts';
import type { Change, Store } from './store.ts';
import type { Model } from './generated/model.ts';
import { toModel } from './convert.ts';

/** Fields and document keys every scenario shares. */
const SHARED_FIELDS = new Set(['id', 'kind', 'x', 'y', 'vertices', 'from', 'to']);
const SHARED_DOC = new Set<DocKey>([
  'title',
  'backdrop',
  'labels',
  'extraSections',
  'isolationValves',
  'criteria',
]);

export interface Scenario {
  id: string;
  name: string;
  /** The scenario this one inherits from, or null for the base network. */
  parent: string | null;
  /** Overridden element fields, by element handle. */
  fields: Record<number, Record<string, unknown>>;
  /** Overridden document data. */
  doc: Partial<Record<DocKey, unknown>>;
}

/** What a project stores of its scenarios. */
export interface ScenarioSet {
  scenarios: Scenario[];
  /** Base values of everything any scenario overrides, as [handle, field, value] and [key, value]. */
  base: { fields: [number, string, unknown][]; doc: [DocKey, unknown][] };
  active: string | null;
}

const clone = <T>(v: T): T => (typeof v === 'object' && v !== null ? structuredClone(v) : v);
const same = (a: unknown, b: unknown) =>
  Object.is(a, b) || (typeof a === 'object' && JSON.stringify(a) === JSON.stringify(b));

export class ScenarioError extends Error {
  override name = 'ScenarioError';
}

export class Scenarios {
  scenarios: Scenario[] = [];
  /** null: the base network is active. */
  active: string | null = null;
  private readonly baseFields = new Map<number, Map<string, unknown>>();
  private readonly baseDoc = new Map<DocKey, unknown>();
  private nextId = 1;
  private switching = false;
  private readonly store: Store;
  private readonly unsubscribe: () => void;

  constructor(store: Store) {
    this.store = store;
    this.unsubscribe = store.subscribe((c) => this.record(c));
  }

  dispose(): void {
    this.unsubscribe();
  }

  get(id: string): Scenario | undefined {
    return this.scenarios.find((s) => s.id === id);
  }

  /** The chain from the root ancestor down to the scenario. */
  lineage(id: string | null): Scenario[] {
    const out: Scenario[] = [];
    let cur = id === null ? undefined : this.get(id);
    while (cur) {
      out.unshift(cur);
      cur = cur.parent === null ? undefined : this.get(cur.parent);
    }
    return out;
  }

  create(name: string, parent: string | null = this.active): string {
    const n = name.trim();
    if (!n) throw new ScenarioError('A scenario needs a name.');
    if (this.scenarios.some((s) => s.name.toLowerCase() === n.toLowerCase()))
      throw new ScenarioError(`A scenario called ${n} already exists.`);
    if (parent !== null && !this.get(parent)) throw new ScenarioError('The parent scenario does not exist.');
    while (this.get(`s${this.nextId}`)) this.nextId++;
    const id = `s${this.nextId++}`;
    this.scenarios.push({ id, name: n, parent, fields: {}, doc: {} });
    return id;
  }

  rename(id: string, name: string): void {
    const s = this.get(id);
    const n = name.trim();
    if (!s) throw new ScenarioError('There is no such scenario.');
    if (!n) throw new ScenarioError('A scenario needs a name.');
    if (this.scenarios.some((x) => x !== s && x.name.toLowerCase() === n.toLowerCase()))
      throw new ScenarioError(`A scenario called ${n} already exists.`);
    s.name = n;
  }

  /** Delete a scenario without children; the base network becomes active if it was. */
  remove(id: string): void {
    if (this.scenarios.some((s) => s.parent === id))
      throw new ScenarioError('Delete or move the scenarios that inherit from this one first.');
    if (this.active === id) this.activate(null);
    this.scenarios = this.scenarios.filter((s) => s.id !== id);
  }

  /** The values a scenario gives every overridden field (base values where it inherits none). */
  private effective(id: string | null): {
    fields: Map<number, Map<string, unknown>>;
    doc: Map<DocKey, unknown>;
  } {
    const fields = new Map<number, Map<string, unknown>>();
    for (const [h, m] of this.baseFields) fields.set(h, new Map(m));
    const doc = new Map(this.baseDoc);
    for (const s of this.lineage(id)) {
      for (const [h, m] of Object.entries(s.fields)) {
        const target = fields.get(Number(h)) ?? new Map<string, unknown>();
        for (const [f, v] of Object.entries(m)) target.set(f, v);
        fields.set(Number(h), target);
      }
      for (const [k, v] of Object.entries(s.doc)) doc.set(k as DocKey, v);
    }
    return { fields, doc };
  }

  /** Operations that turn the document into the scenario's version. */
  private opsFor(id: string | null): Op[] {
    const doc = this.store.doc;
    const want = this.effective(id);
    const ops: Op[] = [];
    for (const [h, m] of want.fields) {
      if (!doc.has(h)) continue;
      for (const [f, v] of m) {
        const now = doc.get(h, f);
        if (!same(now, v)) ops.push({ t: 'set', h, f, v: clone(v), p: now });
      }
    }
    for (const [k, v] of want.doc) {
      const now = doc.data[k];
      if (!same(now, v)) ops.push({ t: 'doc', k, v: clone(v), p: now });
    }
    return ops;
  }

  /** Make a scenario (or the base network, null) the one shown and edited. */
  activate(id: string | null): void {
    if (id !== null && !this.get(id)) throw new ScenarioError('There is no such scenario.');
    const ops = this.opsFor(id);
    this.switching = true;
    try {
      this.store.load(
        (tx) => {
          for (const op of ops) {
            if (op.t === 'set') tx.set(op.h, op.f, op.v);
            else if (op.t === 'doc') tx.setDoc(op.k, op.v as never);
          }
        },
        id === null ? 'Switch to the base network' : `Switch to ${this.get(id)!.name}`,
      );
    } finally {
      this.switching = false;
    }
    this.active = id;
  }

  /** The model a scenario describes, without switching to it. */
  modelFor(id: string | null): Model {
    const doc = this.store.doc;
    const ops = this.opsFor(id);
    const undo: Op[] = [];
    try {
      for (const op of ops) undo.push(doc.apply(op));
      return toModel(doc);
    } finally {
      for (let i = undo.length - 1; i >= 0; i--) doc.apply(undo[i]!);
    }
  }

  /** How many values a scenario changes itself (not counting what it inherits). */
  count(id: string): number {
    const s = this.get(id);
    if (!s) return 0;
    return Object.values(s.fields).reduce((a, m) => a + Object.keys(m).length, 0) + Object.keys(s.doc).length;
  }

  private record(c: Change): void {
    if (this.switching || c.source === 'load') return;
    const active = this.active === null ? undefined : this.get(this.active);
    for (const op of c.ops) {
      if (op.t === 'set') {
        if (SHARED_FIELDS.has(op.f)) continue;
        const known = this.baseFields.get(op.h)?.has(op.f) ?? false;
        if (!active) {
          // An edit to the base network: keep the base copy current.
          if (known) this.baseFields.get(op.h)!.set(op.f, clone(op.v));
          continue;
        }
        if (!known && !this.inherited(op.h, op.f)) {
          const m = this.baseFields.get(op.h) ?? new Map<string, unknown>();
          m.set(op.f, clone(op.p));
          this.baseFields.set(op.h, m);
        }
        const fields = (active.fields[op.h] ??= {});
        fields[op.f] = clone(op.v);
        if (same(op.v, this.parentValue(active, op.h, op.f))) Reflect.deleteProperty(fields, op.f);
        if (Object.keys(fields).length === 0) Reflect.deleteProperty(active.fields, op.h);
      } else if (op.t === 'doc') {
        if (SHARED_DOC.has(op.k)) continue;
        const known = this.baseDoc.has(op.k);
        if (!active) {
          if (known) this.baseDoc.set(op.k, clone(op.v));
          continue;
        }
        if (!known) this.baseDoc.set(op.k, clone(op.p));
        active.doc[op.k] = clone(op.v);
        if (same(op.v, this.parentDocValue(active, op.k))) Reflect.deleteProperty(active.doc, op.k);
      }
    }
  }

  /** Whether any scenario in the active chain already overrides the field. */
  private inherited(h: number, f: string): boolean {
    return this.lineage(this.active).some((s) => s.fields[h] && f in s.fields[h]);
  }

  private parentValue(s: Scenario, h: number, f: string): unknown {
    for (const a of this.lineage(s.parent).reverse())
      if (a.fields[h] && f in a.fields[h]) return a.fields[h][f];
    return this.baseFields.get(h)?.get(f);
  }

  private parentDocValue(s: Scenario, k: DocKey): unknown {
    for (const a of this.lineage(s.parent).reverse()) if (k in a.doc) return a.doc[k];
    return this.baseDoc.get(k);
  }

  toJSON(): ScenarioSet {
    const fields: [number, string, unknown][] = [];
    for (const [h, m] of this.baseFields) for (const [f, v] of m) fields.push([h, f, v]);
    return { scenarios: this.scenarios, base: { fields, doc: [...this.baseDoc] }, active: this.active };
  }

  /** Restore saved scenarios. The document must be the one they were saved with, showing `set.active`. */
  load(set: ScenarioSet): void {
    this.scenarios = structuredClone(set.scenarios);
    this.baseFields.clear();
    for (const [h, f, v] of set.base.fields) {
      const m = this.baseFields.get(h) ?? new Map<string, unknown>();
      m.set(f, v);
      this.baseFields.set(h, m);
    }
    this.baseDoc.clear();
    for (const [k, v] of set.base.doc) this.baseDoc.set(k, v);
    this.active = set.active;
  }
}

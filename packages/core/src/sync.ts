/**
 * Keeping engines' resident models current (ADR 0020). An engine holds the document's
 * model between requests; after edits it receives only what changed, addressed by slot
 * (the element's table row, which never changes while it lives and returns on undo).
 *
 * `EngineSync` watches a store and records, for each revision, the slots and sections
 * its operations touched. `patch(from)` turns the revisions after `from` into a
 * `ModelPatch` read from the document as it is now; `snapshot()` opens an engine.
 */

import { linkToModel, nodeToModel } from './convert.ts';
import type { DocKey, TableName } from './document.ts';
import type { LinkSlot, Model, ModelPatch, NodeSlot, Snapshot } from './generated/model.ts';
import type { Change, Store } from './store.ts';

/** The document and revision an engine is asked to work on. */
export interface SessionRef {
  epoch: number;
  rev: number;
}

/** Document keys that are sections of the model, and their name there. */
const SECTIONS = {
  title: 'title',
  patterns: 'patterns',
  curves: 'curves',
  controls: 'controls',
  rules: 'rules',
  options: 'options',
  times: 'times',
  report: 'report',
  energy: 'energy',
  reactions: 'reactions',
  backdrop: 'backdrop',
  labels: 'labels',
  extraSections: 'extraSections',
} as const satisfies Partial<Record<DocKey, keyof Model>>;

type Section = keyof typeof SECTIONS;

interface Entry {
  rev: number;
  nodes: Set<number>;
  links: Set<number>;
  sections: Set<Section>;
}

let epochs = Math.floor(Math.random() * 2 ** 31);

export class EngineSync {
  /** Identifies this document to engines; another store's revisions never match it. */
  readonly epoch = (epochs = (epochs + 1) >>> 0);
  private readonly store: Store;
  private log: Entry[] = [];
  /** Revisions after this one are in the log. */
  private base: number;
  private readonly limit: number;
  private readonly unsubscribe: () => void;

  constructor(store: Store, options: { limit?: number } = {}) {
    this.store = store;
    this.base = store.rev;
    this.limit = options.limit ?? 4096;
    this.unsubscribe = store.subscribe((c) => this.record(c));
  }

  get rev(): number {
    return this.store.rev;
  }

  get ref(): SessionRef {
    return { epoch: this.epoch, rev: this.store.rev };
  }

  dispose(): void {
    this.unsubscribe();
    this.log = [];
  }

  private record(c: Change): void {
    if (c.source === 'load') {
      this.log = [];
      this.base = c.rev;
      return;
    }
    const doc = this.store.doc;
    const e: Entry = { rev: c.rev, nodes: new Set(), links: new Set(), sections: new Set() };
    const mark = (table: TableName, row: number) => (table === 'node' ? e.nodes : e.links).add(row);
    for (const op of c.ops) {
      if (op.t === 'doc') {
        if (op.k in SECTIONS) e.sections.add(op.k as Section);
        continue;
      }
      const p = doc.place(op.h);
      mark(p.table, p.row);
      // A link names its end nodes by ID: renaming a node changes its links.
      if (op.t === 'set' && op.f === 'id' && p.table === 'node') {
        for (const l of doc.linksAt(op.h)) mark('link', doc.place(l).row);
      }
    }
    this.log.push(e);
    if (this.log.length > this.limit) {
      const dropped = this.log.splice(0, this.log.length - this.limit);
      this.base = dropped.at(-1)!.rev;
    }
  }

  /** The whole model with each element's slot: what opens an engine. */
  snapshot(): Snapshot {
    const doc = this.store.doc;
    const nodes: Model['nodes'] = [];
    const links: Model['links'] = [];
    const nodeSlots: number[] = [];
    const linkSlots: number[] = [];
    for (let r = 0; r < doc.nodes.length; r++) {
      if (doc.nodes.alive[r] !== 1) continue;
      nodes.push(nodeToModel(doc, doc.nodes.handles[r]!));
      nodeSlots.push(r);
    }
    for (let r = 0; r < doc.links.length; r++) {
      if (doc.links.alive[r] !== 1) continue;
      links.push(linkToModel(doc, doc.links.handles[r]!));
      linkSlots.push(r);
    }
    const d = doc.data;
    const model: Model = {
      title: d.title,
      nodes,
      links,
      patterns: d.patterns,
      curves: d.curves,
      controls: d.controls,
      rules: d.rules,
      options: d.options,
      times: d.times,
      report: d.report,
      energy: d.energy,
      reactions: d.reactions,
      backdrop: d.backdrop,
      labels: d.labels,
      extraSections: d.extraSections,
    };
    return { epoch: this.epoch, rev: this.store.rev, model, nodeSlots, linkSlots };
  }

  /**
   * What changed since revision `from`, as a patch an engine holding `from` can apply,
   * or null when the log no longer reaches back that far (send a snapshot instead).
   */
  patch(from: number): ModelPatch | null {
    const rev = this.store.rev;
    if (from < this.base || from > rev) return null;
    const nodes = new Set<number>();
    const links = new Set<number>();
    const sections = new Set<Section>();
    for (const e of this.log) {
      if (e.rev <= from) continue;
      for (const r of e.nodes) nodes.add(r);
      for (const r of e.links) links.add(r);
      for (const s of e.sections) sections.add(s);
    }
    const doc = this.store.doc;
    const nodeSlots: NodeSlot[] = [...nodes]
      .sort((a, b) => a - b)
      .map((r) => ({
        slot: r,
        node: doc.nodes.alive[r] === 1 ? nodeToModel(doc, doc.nodes.handles[r]!) : null,
      }));
    const linkSlots: LinkSlot[] = [...links]
      .sort((a, b) => a - b)
      .map((r) => ({
        slot: r,
        link: doc.links.alive[r] === 1 ? linkToModel(doc, doc.links.handles[r]!) : null,
      }));
    const patch: ModelPatch = { epoch: this.epoch, from, to: rev, nodes: nodeSlots, links: linkSlots };
    for (const s of sections) (patch as Record<string, unknown>)[SECTIONS[s]] = doc.data[s];
    return patch;
  }
}

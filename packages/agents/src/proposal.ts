/**
 * Proposals: what an agent changed in its draft, as a changeset a person reviews and
 * accepts. A changeset names elements by ID, not handle, so it can be applied to the
 * live model later, after the person has kept working; each item records the value it
 * replaces, and an item whose element has changed since is a conflict and is skipped.
 */

import {
  Store,
  type DocData,
  type DocKey,
  type Document,
  LINK_KINDS,
  NODE_KINDS,
  type Criterion,
  type LinkKind,
  type NodeKind,
} from '@waterstudio/core';
import { linkFrame, nodeFrame, type RunResults } from '@waterstudio/engine-client';
import type { CheckReport } from './checker.ts';
import type { Assessment } from './criteria.ts';
import { decode, encode } from '@waterstudio/project';

export type ElementTable = 'node' | 'link';

/** One change. Link ends (`from`, `to`) are node IDs; other values are as the model stores them. */
export type ChangeItem =
  | { op: 'add'; table: ElementTable; kind: string; id: string; values: Record<string, unknown> }
  | { op: 'delete'; table: ElementTable; kind: string; id: string; values: Record<string, unknown> }
  | { op: 'set'; table: ElementTable; kind: string; id: string; field: string; from: unknown; to: unknown }
  | { op: 'doc'; key: DocKey; from: unknown; to: unknown };

/** Key performance indicators of one run, over every report period. */
export interface Kpis {
  periods: number;
  /** EPANET's last warning, in words, or null. */
  warning: string | null;
  minPressure: number | null;
  maxPressure: number | null;
  /** Junctions whose pressure falls below zero at some time. */
  negativePressureJunctions: number;
  maxVelocity: number | null;
  totalDemand: number | null;
}

export interface Evidence {
  before: Kpis | null;
  after: Kpis | null;
  /** The design criteria checked before and after (absent when none are set). */
  criteria?: { before: Assessment | null; after: Assessment | null };
  /** Criteria the change still does not meet, each with the producer's reason. */
  unmet?: { criterion: Criterion; reason: string }[];
  /** Why a run failed, if one did. */
  errors: string[];
}

export type ProposalStatus = 'pending' | 'accepted' | 'partial' | 'rejected' | 'returned';

export interface Proposal {
  id: string;
  title: string;
  rationale: string;
  /** Who made it: the agent session. */
  author: string;
  created: number;
  items: ChangeItem[];
  evidence: Evidence;
  /** The independent checker's report, once it has run (ADR 0021). */
  check?: CheckReport;
  status: ProposalStatus;
  /** The reviewer's comment when sending it back or rejecting it. */
  comment?: string;
}

/** A proposal before the queue gives it an ID and a status. */
export type ProposalDraft = Omit<Proposal, 'id' | 'status' | 'created'>;

const DOC_KEYS: DocKey[] = [
  'title',
  'patterns',
  'curves',
  'controls',
  'rules',
  'options',
  'times',
  'report',
  'energy',
  'reactions',
  'backdrop',
  'labels',
  'extraSections',
  'isolationValves',
  'msx',
];

/** Equal values: identical primitives (NaN equals NaN) or structurally equal data. */
export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => same(x, bb[i]));
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

const copy = <T>(v: T): T => (typeof v === 'object' && v !== null ? structuredClone(v) : v);

/** An element's values with its link ends as node IDs. */
function portable(doc: Document, h: number): Record<string, unknown> {
  const p = doc.place(h);
  const values = doc.table(p.table).readRow(p.row);
  if (p.table === 'link') {
    values['from'] = doc.id(values['from'] as number);
    values['to'] = doc.id(values['to'] as number);
  }
  delete values['kind'];
  return copy(values);
}

function fieldValue(doc: Document, h: number, field: string): unknown {
  const v = doc.get(h, field);
  if (doc.isLink(h) && (field === 'from' || field === 'to')) return doc.id(v as number);
  return v;
}

/**
 * What turns `base` into `draft`, both copies of one document (same handles): elements
 * added, values changed, elements deleted, then document-level data replaced.
 */
export function diffDocuments(base: Document, draft: Document): ChangeItem[] {
  const adds: ChangeItem[] = [];
  const sets: ChangeItem[] = [];
  const deletes: ChangeItem[] = [];
  for (const table of ['node', 'link'] as const) {
    const bt = base.table(table);
    const dt = draft.table(table);
    const columns = [...bt.columns.keys()].filter((c) => c !== 'kind');
    for (const r of bt.rows()) {
      const h = bt.handles[r]!;
      const kind = base.kind(h);
      if (!draft.has(h) || draft.isNode(h) !== (table === 'node')) {
        deletes.push({ op: 'delete', table, kind, id: base.id(h), values: portable(base, h) });
        continue;
      }
      if (draft.kind(h) !== kind) {
        // A change of kind is a replacement.
        deletes.push({ op: 'delete', table, kind, id: base.id(h), values: portable(base, h) });
        adds.push({ op: 'add', table, kind: draft.kind(h), id: draft.id(h), values: portable(draft, h) });
        continue;
      }
      for (const c of columns) {
        // Link ends compare by node, so renaming a node does not move its links.
        const end = table === 'link' && (c === 'from' || c === 'to');
        if (end ? base.get(h, c) === draft.get(h, c) : same(base.get(h, c), draft.get(h, c))) continue;
        const from = fieldValue(base, h, c);
        const to = fieldValue(draft, h, c);
        sets.push({ op: 'set', table, kind, id: base.id(h), field: c, from: copy(from), to: copy(to) });
      }
    }
    for (const r of dt.rows()) {
      const h = dt.handles[r]!;
      if (base.has(h) && base.isNode(h) === (table === 'node')) continue;
      adds.push({ op: 'add', table, kind: draft.kind(h), id: draft.id(h), values: portable(draft, h) });
    }
  }
  const docs: ChangeItem[] = [];
  for (const key of DOC_KEYS) {
    if (!same(base.data[key], draft.data[key])) {
      docs.push({ op: 'doc', key, from: copy(base.data[key]), to: copy(draft.data[key]) });
    }
  }
  // Renames last, so the other items of an element still find it by its old ID.
  sets.sort(
    (a, b) => Number(a.op === 'set' && a.field === 'id') - Number(b.op === 'set' && b.field === 'id'),
  );
  return [...adds, ...sets, ...deletes, ...docs];
}

/** Elements a changeset touches, by table, as IDs before and after the change. */
export function touchedIds(items: readonly ChangeItem[]): { node: Set<string>; link: Set<string> } {
  const out = { node: new Set<string>(), link: new Set<string>() };
  for (const it of items) {
    if (it.op === 'doc') continue;
    out[it.table].add(it.id);
    if (it.op === 'set' && it.field === 'id') out[it.table].add(String(it.to));
  }
  return out;
}

export interface Conflict {
  index: number;
  reason: string;
}

export interface ApplyResult {
  applied: number;
  conflicts: Conflict[];
}

const find = (doc: Document, table: ElementTable, id: string) =>
  table === 'node' ? doc.findNode(id) : doc.findLink(id);

/**
 * Apply the chosen items of a changeset to the live model as one undoable step. Items
 * whose element has changed since the agent forked its draft (the value it replaces is
 * not there any more) are skipped and reported as conflicts.
 */
export function applyChangeset(
  store: Store,
  items: readonly ChangeItem[],
  label: string,
  chosen: (index: number) => boolean = () => true,
): ApplyResult {
  const doc = store.doc;
  const conflicts: Conflict[] = [];
  let applied = 0;
  const order = items.map((it, i) => ({ it, i })).filter(({ i }) => chosen(i));
  const rank = (it: ChangeItem): number => {
    if (it.op === 'add') return it.table === 'node' ? 0 : 1;
    if (it.op === 'set') return it.field === 'id' ? 3 : 2;
    if (it.op === 'delete') return it.table === 'link' ? 4 : 5;
    return 6;
  };
  order.sort((a, b) => rank(a.it) - rank(b.it) || a.i - b.i);
  // Nodes are renamed last, so a node named by its new ID is found by its old one.
  const renamed = new Map<string, string>();
  for (const { it } of order) {
    if (it.op === 'set' && it.table === 'node' && it.field === 'id') renamed.set(String(it.to), it.id);
  }
  const node = (id: string) => doc.findNode(renamed.get(id) ?? id);
  store.transact(label, (tx) => {
    for (const { it, i } of order) {
      const conflict = (reason: string) => conflicts.push({ index: i, reason });
      if (it.op === 'doc') {
        if (!same(doc.data[it.key], it.from)) {
          conflict(`${it.key} has changed since the proposal was made.`);
          continue;
        }
        tx.setDoc(it.key, copy(it.to) as DocData[typeof it.key]);
        applied++;
        continue;
      }
      if (it.op === 'add') {
        if (find(doc, it.table, it.id) !== undefined) {
          conflict(`A ${it.table} called ${it.id} exists already.`);
          continue;
        }
        const values = copy(it.values);
        if (it.table === 'link') {
          const from = node(String(values['from']));
          const to = node(String(values['to']));
          if (from === undefined || to === undefined) {
            conflict(`An end node of ${it.id} does not exist.`);
            continue;
          }
          values['from'] = from;
          values['to'] = to;
          tx.addLink(it.kind as LinkKind, values);
        } else {
          tx.addNode(it.kind as NodeKind, values);
        }
        applied++;
        continue;
      }
      const h = find(doc, it.table, it.id);
      if (h === undefined) {
        if (it.op === 'delete')
          applied++; // gone already
        else conflict(`${it.id} no longer exists.`);
        continue;
      }
      if (doc.kind(h) !== it.kind) {
        conflict(`${it.id} is now a ${doc.kind(h)}.`);
        continue;
      }
      if (it.op === 'set') {
        if (!same(fieldValue(doc, h, it.field), it.from)) {
          conflict(`${it.field} of ${it.id} has changed since the proposal was made.`);
          continue;
        }
        let v = copy(it.to);
        if (it.table === 'link' && (it.field === 'from' || it.field === 'to')) {
          const n = node(String(v));
          if (n === undefined) {
            conflict(`Node ${String(v)} does not exist.`);
            continue;
          }
          v = n;
        }
        if (it.field === 'id' && find(doc, it.table, String(v)) !== undefined) {
          conflict(`${String(v)} is already used.`);
          continue;
        }
        tx.set(h, it.field, v);
        applied++;
        continue;
      }
      // Delete: the element must be as the agent saw it, and a node must have no other links.
      const now = portable(doc, h);
      if (!same(now, it.values)) {
        conflict(`${it.id} has changed since the proposal was made.`);
        continue;
      }
      if (it.table === 'node' && doc.linksAt(h).length > 0) {
        conflict(`${it.id} still has links attached.`);
        continue;
      }
      tx.delete(h);
      applied++;
    }
  });
  return { applied, conflicts };
}

/** A draft for an agent: a copy of the model to edit and the copy it started from. */
export class Sandbox {
  readonly base: Document;
  readonly store: Store;

  constructor(doc: Document) {
    this.base = doc.clone();
    this.store = new Store(doc.clone());
  }

  get draft(): Document {
    return this.store.doc;
  }

  changes(): ChangeItem[] {
    return diffDocuments(this.base, this.store.doc);
  }
}

const WARNING_TEXT: Record<number, string> = {
  1: 'the system is hydraulically unbalanced',
  2: 'the system may be hydraulically unstable',
  4: 'pumps cannot deliver enough flow or head',
  5: 'valves cannot deliver enough flow or pressure',
  6: 'the system has negative pressures',
};

/** The KPIs of a run of `doc` (`nodes`, `links`: handles in result column order). */
export function kpis(doc: Document, r: RunResults, nodes: Uint32Array, links: Uint32Array): Kpis {
  let minP = Infinity;
  let maxP = -Infinity;
  let maxV = -Infinity;
  let demand = 0;
  const negative = new Set<number>();
  const junction = Array.from(nodes, (h) => doc.has(h) && doc.nodeKind(h) === 'junction');
  const pipe = Array.from(links, (h) => doc.has(h) && doc.linkKind(h) === 'pipe');
  for (let p = 0; p < r.times.length; p++) {
    const pr = nodeFrame(r, 'pressure', p);
    const dm = nodeFrame(r, 'demand', p);
    junction.forEach((j, i) => {
      if (!j) return;
      const x = pr[i]!;
      if (x < minP) minP = x;
      if (x > maxP) maxP = x;
      if (x < 0) negative.add(i);
      if (p === 0) demand += dm[i]!;
    });
    const v = linkFrame(r, 'velocity', p);
    pipe.forEach((isPipe, i) => {
      if (isPipe && v[i]! > maxV) maxV = v[i]!;
    });
  }
  const fin = (x: number) => (Number.isFinite(x) ? Number(x.toFixed(3)) : null);
  return {
    periods: r.times.length,
    warning: WARNING_TEXT[r.warning] ?? null,
    minPressure: fin(minP),
    maxPressure: fin(maxP),
    negativePressureJunctions: negative.size,
    maxVelocity: fin(maxV),
    totalDemand: r.times.length > 0 ? fin(demand) : null,
  };
}

export const ELEMENT_KINDS: readonly string[] = [...NODE_KINDS, ...LINK_KINDS];

/** The format of a proposals file (what a headless agent leaves for a person to review). */
export const PROPOSALS_FORMAT = 'waterstudio-proposals';

/** Proposals as a file, lossless for every number (NaN marks a missing value). */
export function proposalsToText(network: string, proposals: readonly Proposal[]): string {
  return encode({ format: PROPOSALS_FORMAT, version: 1, network, proposals });
}

/** Read a proposals file; throws if it is not one. */
export function proposalsFromText(text: string): { network: string; proposals: Proposal[] } {
  let v: unknown;
  try {
    v = decode(text);
  } catch {
    throw new Error('This is not a proposals file.');
  }
  const o = (typeof v === 'object' && v !== null ? v : {}) as {
    format?: unknown;
    network?: unknown;
    proposals?: unknown;
  };
  if (o.format !== PROPOSALS_FORMAT || !Array.isArray(o.proposals))
    throw new Error('This is not a proposals file.');
  return { network: typeof o.network === 'string' ? o.network : '', proposals: o.proposals as Proposal[] };
}

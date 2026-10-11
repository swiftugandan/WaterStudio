/**
 * Editing operations: the network-aware layer over the store that commands, tools and
 * agents call. Each function is one undoable transaction and keeps the network valid
 * (unique IDs, links always between existing nodes).
 */

import type { Document } from './document.ts';
import { fieldsOf, linkField, nodeField, type LinkKind, type NodeKind } from './schema.ts';
import type { Store, Tx } from './store.ts';

export class EditError extends Error {
  override name = 'EditError';
}

/** EPANET's limit on ID length. */
export const MAX_ID = 31;

export function validateId(id: string): string | undefined {
  if (id.length === 0) return 'An ID cannot be empty.';
  if (id.length > MAX_ID) return `An ID can have at most ${MAX_ID} characters.`;
  if (/[\s;"]/.test(id)) return 'An ID cannot contain spaces, semicolons or double quotes.';
  return undefined;
}

/** The next free ID in a series: the prefix followed by the smallest unused number. */
export function nextId(doc: Document, table: 'node' | 'link', prefix = ''): string {
  const taken = (id: string) => (table === 'node' ? doc.findNode(id) : doc.findLink(id)) !== undefined;
  let n = (table === 'node' ? doc.nodes.liveCount : doc.links.liveCount) + 1;
  while (taken(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export interface NodeInit {
  x: number;
  y: number;
  id?: string;
  values?: Record<string, unknown>;
}

export function addNode(store: Store, kind: NodeKind, init: NodeInit): number {
  const id = init.id ?? nextId(store.doc, 'node');
  const err = validateId(id);
  if (err) throw new EditError(err);
  if (store.doc.findNode(id) !== undefined) throw new EditError(`A node called ${id} already exists.`);
  const label = `Add ${kind} ${id}`;
  return store.transact(label, (tx) => {
    const values: Record<string, unknown> = { ...init.values, id, x: init.x, y: init.y };
    if (kind === 'junction' && values['demands'] === undefined)
      values['demands'] = [{ base: 0, pattern: null, category: null }];
    return tx.addNode(kind, values);
  });
}

export interface LinkInit {
  from: number;
  to: number;
  id?: string;
  /** Interior points, flat [x, y, ...]. */
  vertices?: number[];
  values?: Record<string, unknown>;
}

export function addLink(store: Store, kind: LinkKind, init: LinkInit): number {
  const doc = store.doc;
  if (!doc.isNode(init.from) || !doc.has(init.from)) throw new EditError('The start node does not exist.');
  if (!doc.isNode(init.to) || !doc.has(init.to)) throw new EditError('The end node does not exist.');
  if (init.from === init.to) throw new EditError('A link must join two different nodes.');
  const id = init.id ?? nextId(doc, 'link');
  const err = validateId(id);
  if (err) throw new EditError(err);
  if (doc.findLink(id) !== undefined) throw new EditError(`A link called ${id} already exists.`);
  return store.transact(`Add ${kind} ${id}`, (tx) =>
    tx.addLink(kind, { ...init.values, id, from: init.from, to: init.to, vertices: init.vertices ?? [] }),
  );
}

/** Move nodes (and the vertices of links between moved nodes) by an offset. */
export function moveNodes(
  store: Store,
  handles: Iterable<number>,
  dx: number,
  dy: number,
  coalesce?: string,
  /** With auto-length on: the new plan length of a pipe, applied in the same step. */
  lengthOf?: (link: number) => number | undefined,
): void {
  const doc = store.doc;
  const moved = new Set([...handles].filter((h) => doc.isNode(h)));
  if (moved.size === 0 || (dx === 0 && dy === 0)) return;
  store.transact(
    moved.size === 1 ? `Move ${doc.id([...moved][0]!)}` : `Move ${moved.size} nodes`,
    (tx) => {
      for (const h of moved) {
        tx.set(h, 'x', doc.num(h, 'x') + dx);
        tx.set(h, 'y', doc.num(h, 'y') + dy);
      }
      for (const l of doc.linkHandles()) {
        const a = moved.has(doc.num(l, 'from'));
        const b = moved.has(doc.num(l, 'to'));
        if (a && b) {
          const v = doc.get(l, 'vertices') as number[];
          if (v.length > 0)
            tx.set(
              l,
              'vertices',
              v.map((c, i) => c + (i % 2 === 0 ? dx : dy)),
            );
        }
        if ((a || b) && lengthOf && doc.linkKind(l) === 'pipe') setLength(tx, l, lengthOf(l));
      }
    },
    coalesce === undefined ? {} : { coalesce },
  );
}

/** Delete elements; deleting a node deletes the links attached to it. */
export function deleteElements(store: Store, handles: Iterable<number>): number {
  const doc = store.doc;
  const nodes = new Set<number>();
  const links = new Set<number>();
  for (const h of handles) {
    if (!doc.has(h)) continue;
    if (doc.isNode(h)) nodes.add(h);
    else links.add(h);
  }
  for (const n of nodes) for (const l of doc.linksAt(n)) links.add(l);
  const count = nodes.size + links.size;
  if (count === 0) return 0;
  store.transact(
    count === 1 ? `Delete ${doc.id([...nodes, ...links][0]!)}` : `Delete ${count} elements`,
    (tx) => {
      for (const l of links) tx.delete(l);
      for (const n of nodes) tx.delete(n);
    },
  );
  return count;
}

/** Set one field on several elements, validating the value against the catalogue. */
export function setField(
  store: Store,
  handles: readonly number[],
  field: string,
  value: unknown,
  coalesce?: string,
): void {
  const doc = store.doc;
  const targets = handles.filter((h) => doc.has(h));
  if (targets.length === 0) return;
  for (const h of targets) {
    const spec = (doc.isNode(h) ? nodeField : linkField).get(field);
    if (!spec || !fieldsOf(doc.kind(h)).includes(spec))
      throw new EditError(`${doc.kind(h)} has no field ${field}.`);
    if (spec.editor.type === 'number') {
      if (typeof value !== 'number' || (Number.isNaN(value) && !spec.editor.optional)) {
        throw new EditError(`${spec.label} must be a number.`);
      }
      if (spec.editor.min !== undefined && value < spec.editor.min) {
        throw new EditError(`${spec.label} cannot be less than ${spec.editor.min}.`);
      }
    }
  }
  if (field === 'id') {
    if (targets.length > 1) throw new EditError('Several elements cannot share one ID.');
    const id = String(value);
    const err = validateId(id);
    if (err) throw new EditError(err);
    const h = targets[0]!;
    const clash = doc.isNode(h) ? doc.findNode(id) : doc.findLink(id);
    if (clash !== undefined && clash !== h) throw new EditError(`${id} is already used.`);
  }
  const label =
    targets.length === 1
      ? `Set ${field} of ${doc.id(targets[0]!)}`
      : `Set ${field} of ${targets.length} elements`;
  store.transact(
    label,
    (tx) => {
      for (const h of targets) tx.set(h, field, value);
    },
    coalesce === undefined ? {} : { coalesce },
  );
}

export type GroupAction = 'replace' | 'multiply' | 'add';

/**
 * EPANET's group edit: replace a numeric field on every element, or multiply it by or
 * add to it a value, as one undoable step. Elements whose kind lacks the field are
 * skipped; a result below the field's minimum is refused before anything changes.
 */
export function groupEdit(
  store: Store,
  handles: readonly number[],
  field: string,
  action: GroupAction,
  value: number,
): number {
  const doc = store.doc;
  if (!Number.isFinite(value)) throw new EditError('The value must be a number.');
  const targets: [number, number][] = [];
  let label = field;
  for (const h of handles) {
    if (!doc.has(h)) continue;
    const spec = (doc.isNode(h) ? nodeField : linkField).get(field);
    if (!spec || spec.editor.type !== 'number' || !fieldsOf(doc.kind(h)).includes(spec)) continue;
    label = spec.label.toLowerCase();
    const old = doc.num(h, field);
    const next =
      action === 'replace'
        ? value
        : Number.isNaN(old)
          ? NaN
          : action === 'multiply'
            ? old * value
            : old + value;
    if (Number.isNaN(next)) continue;
    if (spec.editor.min !== undefined && next < spec.editor.min)
      throw new EditError(`${spec.label} of ${doc.id(h)} would be ${next}, below ${spec.editor.min}.`);
    targets.push([h, next]);
  }
  if (targets.length === 0) return 0;
  store.transact(`Group edit ${label} of ${targets.length} elements`, (tx) => {
    for (const [h, v] of targets) tx.set(h, field, v);
  });
  return targets.length;
}

function setLength(tx: Tx, link: number, length: number | undefined): void {
  if (length === undefined || !Number.isFinite(length) || length <= 0) return;
  tx.set(link, 'length', Math.round(length * 100) / 100);
}

/** Replace a link's interior points (flat [x, y, ...]), and its length when auto-length gives one. */
export function setVertices(
  store: Store,
  link: number,
  vertices: number[],
  lengthOf?: (link: number) => number | undefined,
): void {
  const doc = store.doc;
  if (!doc.isLink(link) || !doc.has(link)) throw new EditError('That is not a link.');
  if (vertices.length % 2 !== 0 || vertices.some((v) => !Number.isFinite(v)))
    throw new EditError('Vertices must be pairs of numbers.');
  store.transact(`Edit vertices of ${doc.id(link)}`, (tx) => {
    tx.set(link, 'vertices', vertices);
    if (lengthOf && doc.linkKind(link) === 'pipe') setLength(tx, link, lengthOf(link));
  });
}

/** Reverse the direction of links: swap their end nodes and reverse their vertices. */
export function reverseLinks(store: Store, handles: Iterable<number>): number {
  const doc = store.doc;
  const links = [...handles].filter((h) => doc.has(h) && doc.isLink(h));
  if (links.length === 0) return 0;
  store.transact(
    links.length === 1 ? `Reverse ${doc.id(links[0]!)}` : `Reverse ${links.length} links`,
    (tx) => {
      for (const l of links) {
        const from = doc.num(l, 'from');
        const to = doc.num(l, 'to');
        const v = doc.get(l, 'vertices') as number[];
        const r: number[] = [];
        for (let k = v.length - 2; k >= 0; k -= 2) r.push(v[k]!, v[k + 1]!);
        tx.set(l, 'from', to);
        tx.set(l, 'to', from);
        if (v.length > 0) tx.set(l, 'vertices', r);
      }
    },
  );
  return links.length;
}

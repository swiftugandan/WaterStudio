/**
 * Conditions on elements, as EPANET's map query and table filters state them: an
 * attribute (a numeric property, or a result at the current report time), a relation
 * (below, equal to, above) and a value. Used to select elements, to filter the results
 * table and to limit group edits.
 */

import { fieldsOf, LINK_KINDS, NODE_KINDS, unitLabel, type FieldSpec } from '@waterstudio/core';
import {
  linkFrame,
  linkVariables,
  nodeFrame,
  nodeVariables,
  type LinkVar,
  type NodeVar,
} from '@waterstudio/engine-client';
import { variableLabel } from '../shell/Ribbon.tsx';
import { variableUnit } from '../viewport/paint.ts';
import type { AppState } from './state.ts';

export type Relation = 'below' | 'equal' | 'above';

export interface Condition {
  table: 'node' | 'link';
  /** A field name, or `result:<variable>`. */
  attribute: string;
  relation: Relation;
  value: number;
}

export interface Attribute {
  id: string;
  label: string;
  unit: string;
  result: boolean;
}

/** Numeric properties any kind in the table has. */
export function numericFields(table: 'node' | 'link'): FieldSpec[] {
  const out: FieldSpec[] = [];
  for (const k of table === 'node' ? NODE_KINDS : LINK_KINDS)
    for (const f of fieldsOf(k))
      if (f.editor.type === 'number' && f.name !== 'x' && f.name !== 'y' && !out.includes(f)) out.push(f);
  return out;
}

export function attributes(state: AppState, table: 'node' | 'link'): Attribute[] {
  const props = numericFields(table).map((f) => ({
    id: f.name,
    label: f.label,
    unit: unitLabel(f.quantity, state.units),
    result: false,
  }));
  if (state.run.status !== 'done') return props;
  const run = state.run.results;
  const results = (table === 'node' ? nodeVariables(run) : linkVariables(run)).map((v) => ({
    id: `result:${v}`,
    label: `${variableLabel(v)} (result)`,
    unit: variableUnit(v, state.units, run),
    result: true,
  }));
  return [...results, ...props];
}

/** The attribute's value for each element handle (NaN where it has none). */
export function valueOf(state: AppState, table: 'node' | 'link', attribute: string): (h: number) => number {
  const doc = state.store.doc;
  if (attribute.startsWith('result:')) {
    const r = state.run;
    if (r.status !== 'done' || !r.results || !r.nodes || !r.links) return () => NaN;
    const v = attribute.slice(7);
    const handles = table === 'node' ? r.nodes : r.links;
    const frame =
      table === 'node'
        ? nodeFrame(r.results, v as NodeVar, state.period)
        : linkFrame(r.results, v as LinkVar, state.period);
    const col = new Map<number, number>();
    handles.forEach((h, i) => col.set(h, i));
    return (h) => {
      const i = col.get(h);
      return i === undefined ? NaN : frame[i]!;
    };
  }
  return (h) => {
    const v = doc.get(h, attribute);
    return typeof v === 'number' ? v : NaN;
  };
}

export function holds(relation: Relation, x: number, value: number): boolean {
  if (!Number.isFinite(x)) return false;
  switch (relation) {
    case 'below':
      return x < value;
    case 'above':
      return x > value;
    case 'equal':
      return Math.abs(x - value) <= 1e-6 * Math.max(1, Math.abs(value));
  }
}

/** Elements of the table meeting the condition, in element order (optionally only among `within`). */
export function matching(state: AppState, c: Condition, within?: ReadonlySet<number>): number[] {
  const doc = state.store.doc;
  const get = valueOf(state, c.table, c.attribute);
  const out: number[] = [];
  for (const h of c.table === 'node' ? doc.nodeHandles() : doc.linkHandles()) {
    if (within && !within.has(h)) continue;
    if (holds(c.relation, get(h), c.value)) out.push(h);
  }
  return out;
}

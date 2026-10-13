/**
 * What a project holds, independent of how it is stored: the network as a canonical
 * model, its scenarios, and what EPANET files have no place for. Element references are
 * IDs, not the session's handles, so a project opens the same in any session.
 */

import type { Criteria, Document, DocKey, model, MsxInput, ScenarioSet } from '@waterstudio/core';

/** A reference to an element by ID: `node:<id>` or `link:<id>` (node and link IDs may coincide). */
export type ElementRef = `node:${string}` | `link:${string}`;

export interface StoredScenario {
  id: string;
  name: string;
  parent: string | null;
  fields: Record<ElementRef, Record<string, unknown>>;
  doc: Partial<Record<DocKey, unknown>>;
}

/** The scenario manager's state with element IDs instead of handles. */
export interface StoredScenarios {
  scenarios: StoredScenario[];
  base: { fields: [ElementRef, string, unknown][]; doc: [DocKey, unknown][] };
  active: string | null;
}

export interface ProjectData {
  /** The name of the file the network came from (e.g. "Net1.inp"). */
  fileName: string;
  /** The network as shown when saved: the active scenario's values applied. */
  model: model.Model;
  scenarios: StoredScenarios | null;
  /** Isolation valves as (link ID, node ID). */
  isolationValves: { link: string; node: string }[];
  msx: MsxInput | null;
  /** The design criteria (absent in projects saved before they existed). */
  criteria?: Criteria;
  /** How the project was being viewed (map theme, time step, ...), as the app chooses. */
  settings: Record<string, unknown>;
}

/** The reference of an element of `doc`, or null if it no longer exists. */
export function refOf(doc: Document, h: number): ElementRef | null {
  if (!doc.has(h)) return null;
  return doc.isNode(h) ? `node:${doc.id(h)}` : `link:${doc.id(h)}`;
}

/** The handle an element reference names in `doc`, if any. */
export function handleOf(doc: Document, ref: string): number | undefined {
  if (ref.startsWith('node:')) return doc.findNode(ref.slice(5));
  if (ref.startsWith('link:')) return doc.findLink(ref.slice(5));
  return undefined;
}

/** Scenarios by element ID. Overrides of elements that no longer exist are dropped. */
export function storeScenarios(doc: Document, set: ScenarioSet): StoredScenarios {
  return {
    scenarios: set.scenarios.map((s) => {
      const fields: Record<ElementRef, Record<string, unknown>> = {};
      for (const [h, f] of Object.entries(s.fields)) {
        const ref = refOf(doc, Number(h));
        if (ref) fields[ref] = f;
      }
      return { id: s.id, name: s.name, parent: s.parent, fields, doc: s.doc };
    }),
    base: {
      fields: set.base.fields.flatMap(([h, f, v]): [ElementRef, string, unknown][] => {
        const ref = refOf(doc, h);
        return ref ? [[ref, f, v]] : [];
      }),
      doc: set.base.doc,
    },
    active: set.active,
  };
}

/** Scenarios by the handles of `doc`. References to unknown elements are dropped. */
export function restoreScenarios(doc: Document, stored: StoredScenarios): ScenarioSet {
  return {
    scenarios: stored.scenarios.map((s) => {
      const fields: Record<number, Record<string, unknown>> = {};
      for (const [ref, f] of Object.entries(s.fields)) {
        const h = handleOf(doc, ref);
        if (h !== undefined) fields[h] = f;
      }
      return { id: s.id, name: s.name, parent: s.parent, fields, doc: s.doc };
    }),
    base: {
      fields: stored.base.fields.flatMap(([ref, f, v]): [number, string, unknown][] => {
        const h = handleOf(doc, ref);
        return h === undefined ? [] : [[h, f, v]];
      }),
      doc: stored.base.doc,
    },
    active: stored.active,
  };
}

/**
 * Defaults for new elements, as EPANET's Project › Defaults: an ID prefix per element
 * type and starting values for the properties most often typed. Remembered in this
 * browser; a value left empty uses a built-in default suited to the model's units.
 */

import { nextId, type LinkKind, type NodeKind, type UnitSystem } from '@waterstudio/core';
import type { AppState } from './state.ts';

export const DEFAULT_KEYS = [
  'junctionElevation',
  'tankElevation',
  'tankDiameter',
  'tankInitLevel',
  'tankMaxLevel',
  'pipeLength',
  'pipeDiameter',
  'pipeRoughness',
] as const;
export type DefaultKey = (typeof DEFAULT_KEYS)[number];

export interface Defaults {
  prefixes: Record<NodeKind | LinkKind, string>;
  values: Partial<Record<DefaultKey, number>>;
}

export const EMPTY_DEFAULTS: Defaults = {
  prefixes: { junction: '', reservoir: '', tank: '', pipe: '', pump: '', valve: '' },
  values: {},
};

/** Built-in starting values in the model's units. */
export function builtIn(key: DefaultKey, u: UnitSystem): number {
  const si = u.si;
  switch (key) {
    case 'junctionElevation':
    case 'tankElevation':
      return 0;
    case 'tankDiameter':
      return si ? 15 : 50;
    case 'tankInitLevel':
      return si ? 3 : 10;
    case 'tankMaxLevel':
      return si ? 6 : 20;
    case 'pipeLength':
      return si ? 300 : 1000;
    case 'pipeDiameter':
      return si ? 300 : 12;
    case 'pipeRoughness':
      return u.headloss === 'D-W' ? (si ? 0.1 : 0.3) : u.headloss === 'C-M' ? 0.011 : 100;
  }
}

export function readDefaults(): Defaults {
  try {
    const v = JSON.parse(localStorage.getItem('ws.defaults') ?? '{}') as Partial<Defaults>;
    const prefixes = { ...EMPTY_DEFAULTS.prefixes };
    for (const k of Object.keys(prefixes) as (keyof Defaults['prefixes'])[])
      if (typeof v.prefixes?.[k] === 'string') prefixes[k] = v.prefixes[k];
    const values: Defaults['values'] = {};
    for (const k of DEFAULT_KEYS) {
      const x = v.values?.[k];
      if (typeof x === 'number' && Number.isFinite(x)) values[k] = x;
    }
    return { prefixes, values };
  } catch {
    return { prefixes: { ...EMPTY_DEFAULTS.prefixes }, values: {} };
  }
}

export function saveDefaults(d: Defaults): void {
  try {
    localStorage.setItem('ws.defaults', JSON.stringify(d));
  } catch {
    // Without storage the defaults last for this page.
  }
}

/** The ID and starting values for a new element of a kind. */
export function newElement(
  state: AppState,
  kind: NodeKind | LinkKind,
): { id?: string; values: Record<string, unknown> } {
  const d = state.defaults;
  const v = (k: DefaultKey) => d.values[k] ?? builtIn(k, state.units);
  const prefix = d.prefixes[kind];
  const table = kind === 'pipe' || kind === 'pump' || kind === 'valve' ? 'link' : 'node';
  const id = prefix ? nextId(state.store.doc, table, prefix) : undefined;
  let values: Record<string, unknown> = {};
  if (kind === 'junction') values = { elevation: v('junctionElevation') };
  else if (kind === 'tank')
    values = {
      elevation: v('tankElevation'),
      diameter: v('tankDiameter'),
      initLevel: v('tankInitLevel'),
      maxLevel: v('tankMaxLevel'),
    };
  else if (kind === 'pipe')
    values = { length: v('pipeLength'), diameter: v('pipeDiameter'), roughness: v('pipeRoughness') };
  return { ...(id ? { id } : {}), values };
}

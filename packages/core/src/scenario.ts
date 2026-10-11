/**
 * EPANET scenario files (File › Export/Import › Scenario): a subset of a network's
 * data in .inp style sections, to apply to the same network later. Sections are
 * [DEMANDS] (every demand category of a junction), [QUALITY] (initial quality),
 * [DIAMETERS] and [ROUGHNESS] (of pipes), and [CONTROLS] and [RULES], which replace
 * the network's own. Importing is one undoable edit; IDs the network lacks are
 * reported and skipped.
 */

import { controlsText, parseControls, parseRules, rulesText } from './data.ts';
import type { Document } from './document.ts';
import { EditError } from './edits.ts';
import type { Demand } from './generated/model.ts';
import { getfloat } from './options.ts';
import type { Store } from './store.ts';

const fmt = (v: number) => String(Number(v.toPrecision(10)));

export function scenarioText(doc: Document, name = 'Scenario'): string {
  const out: string[] = ['[TITLE]', name, '', '[DEMANDS]', ';Junction\tDemand\tPattern\tCategory'];
  for (const h of doc.nodeHandles()) {
    if (doc.nodeKind(h) !== 'junction') continue;
    for (const d of doc.get(h, 'demands') as Demand[])
      out.push(`${doc.id(h)}\t${fmt(d.base)}\t${d.pattern ?? ''}${d.category ? `\t;${d.category}` : ''}`);
  }
  out.push('', '[QUALITY]', ';Node\tInitial quality');
  for (const h of doc.nodeHandles()) {
    const q = doc.num(h, 'initialQuality');
    if (Number.isFinite(q)) out.push(`${doc.id(h)}\t${fmt(q)}`);
  }
  out.push('', '[DIAMETERS]', ';Pipe\tDiameter');
  const pipes = [...doc.linkHandles()].filter((h) => doc.linkKind(h) === 'pipe');
  for (const h of pipes) out.push(`${doc.id(h)}\t${fmt(doc.num(h, 'diameter'))}`);
  out.push('', '[ROUGHNESS]', ';Pipe\tRoughness');
  for (const h of pipes) out.push(`${doc.id(h)}\t${fmt(doc.num(h, 'roughness'))}`);
  out.push(
    '',
    '[CONTROLS]',
    controlsText(doc.data.controls),
    '',
    '[RULES]',
    rulesText(doc.data.rules),
    '',
    '[END]',
    '',
  );
  return out.join('\n');
}

export interface ScenarioResult {
  /** Sections applied, with how many lines each. */
  applied: Record<string, number>;
  issues: string[];
}

/** Apply a scenario file to the network as one undoable edit. */
export function applyScenario(store: Store, text: string): ScenarioResult {
  const doc = store.doc;
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const t = raw.trim();
    const head = /^\[([A-Z]+)\]/i.exec(t);
    if (head) {
      const name = head[1]!.toUpperCase();
      if (name === 'END') break;
      current = [];
      sections.set(name, current);
      continue;
    }
    current?.push(raw);
  }
  const known = ['TITLE', 'DEMANDS', 'QUALITY', 'DIAMETERS', 'ROUGHNESS', 'CONTROLS', 'RULES'];
  const issues: string[] = [];
  for (const k of sections.keys())
    if (!known.includes(k)) issues.push(`[${k}] is not a scenario section; skipped.`);
  if (![...sections.keys()].some((k) => known.includes(k) && k !== 'TITLE'))
    throw new EditError('This file has none of the sections a scenario holds.');
  const rows = (name: string) =>
    (sections.get(name) ?? [])
      .map((l) => {
        const i = l.indexOf(';');
        return {
          tokens: (i < 0 ? l : l.slice(0, i)).trim().split(/\s+/).filter(Boolean),
          comment: i < 0 ? null : l.slice(i + 1).trim() || null,
        };
      })
      .filter((r) => r.tokens.length > 0);
  const applied: Record<string, number> = {};
  const missing = new Set<string>();
  const number = (s: string | undefined, what: string) => {
    const v = s === undefined ? undefined : getfloat(s);
    if (v === undefined) issues.push(`${what}: “${s ?? ''}” is not a number.`);
    return v;
  };
  const controls = sections.has('CONTROLS')
    ? parseControls((sections.get('CONTROLS') ?? []).join('\n'))
    : null;
  const rules = sections.has('RULES') ? parseRules((sections.get('RULES') ?? []).join('\n')) : null;

  store.transact('Import scenario', (tx) => {
    if (sections.has('DEMANDS')) {
      const by = new Map<number, Demand[]>();
      let n = 0;
      for (const r of rows('DEMANDS')) {
        const h = doc.findNode(r.tokens[0]!);
        if (h === undefined || doc.nodeKind(h) !== 'junction') {
          missing.add(r.tokens[0]!);
          continue;
        }
        const base = number(r.tokens[1], `Demand of ${r.tokens[0]!}`);
        if (base === undefined) continue;
        const list = by.get(h) ?? [];
        list.push({ base, pattern: r.tokens[2] ?? null, category: r.comment });
        by.set(h, list);
        n++;
      }
      for (const [h, list] of by) tx.set(h, 'demands', list);
      applied['DEMANDS'] = n;
    }
    if (sections.has('QUALITY')) {
      let n = 0;
      for (const r of rows('QUALITY')) {
        const h = doc.findNode(r.tokens[0]!);
        if (h === undefined) {
          missing.add(r.tokens[0]!);
          continue;
        }
        const q = number(r.tokens[1], `Quality of ${r.tokens[0]!}`);
        if (q === undefined) continue;
        tx.set(h, 'initialQuality', q);
        n++;
      }
      applied['QUALITY'] = n;
    }
    for (const [section, field] of [
      ['DIAMETERS', 'diameter'],
      ['ROUGHNESS', 'roughness'],
    ] as const) {
      if (!sections.has(section)) continue;
      let n = 0;
      for (const r of rows(section)) {
        const h = doc.findLink(r.tokens[0]!);
        if (h === undefined || doc.linkKind(h) !== 'pipe') {
          missing.add(r.tokens[0]!);
          continue;
        }
        const v = number(r.tokens[1], `${field} of ${r.tokens[0]!}`);
        if (v === undefined) continue;
        if (v <= 0) {
          issues.push(`The ${field} of pipe ${r.tokens[0]!} must be more than 0.`);
          continue;
        }
        tx.set(h, field, v);
        n++;
      }
      applied[section] = n;
    }
    if (controls) {
      tx.setDoc('controls', controls);
      applied['CONTROLS'] = controls.length;
    }
    if (rules) {
      tx.setDoc('rules', rules);
      applied['RULES'] = rules.length;
    }
  });
  if (missing.size > 0) {
    const ids = [...missing];
    issues.push(
      `Not in this network, skipped: ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ` and ${ids.length - 8} more` : ''}.`,
    );
  }
  return { applied, issues };
}

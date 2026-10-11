/**
 * Editing the network's data objects: time patterns and curves. Each function is one
 * undoable transaction. Renaming a pattern or curve renames every reference to it
 * (elements, demands, sources and the options that name patterns); one in use cannot
 * be deleted, and `patternUses`/`curveUses` say where it is used.
 */

import type { Document } from './document.ts';
import { EditError, validateId } from './edits.ts';
import type {
  Control,
  Curve,
  CurveKind,
  Demand,
  KeywordSection,
  Pattern,
  Rule,
  Source,
} from './generated/model.ts';
import { keywordMatches } from './units.ts';
import { readOption, writeOption } from './options.ts';
import type { Store, Tx } from './store.ts';

const NODE_PATTERN_FIELDS = ['headPattern'] as const;
const LINK_PATTERN_FIELDS = ['pattern', 'pricePattern'] as const;
const NODE_CURVE_FIELDS = ['volumeCurve'] as const;
const LINK_CURVE_FIELDS = ['pumpCurve', 'efficiencyCurve', 'settingCurve', 'pcvCurve'] as const;

const FIELD_LABEL: Record<string, string> = {
  headPattern: 'head pattern',
  pattern: 'speed pattern',
  pricePattern: 'price pattern',
  volumeCurve: 'volume curve',
  pumpCurve: 'pump curve',
  efficiencyCurve: 'efficiency curve',
  settingCurve: 'setting curve',
  pcvCurve: 'position curve',
};

function has(doc: Document, h: number, field: string): boolean {
  // Only kinds that have the field carry a meaningful value in it.
  const v = doc.get(h, field);
  return v !== null && v !== undefined;
}

/** Where a pattern is used, as short descriptions ("junction J1 demand", "option PATTERN"). */
export function patternUses(doc: Document, id: string): string[] {
  const out: string[] = [];
  for (const h of doc.nodeHandles()) {
    for (const f of NODE_PATTERN_FIELDS)
      if (has(doc, h, f) && doc.get(h, f) === id)
        out.push(`${doc.nodeKind(h)} ${doc.id(h)} ${FIELD_LABEL[f]}`);
    const demands = doc.get(h, 'demands') as Demand[] | null;
    if (demands?.some((d) => d.pattern === id)) out.push(`junction ${doc.id(h)} demand`);
    const src = doc.get(h, 'source') as Source | null;
    if (src?.pattern === id) out.push(`${doc.nodeKind(h)} ${doc.id(h)} source`);
  }
  for (const h of doc.linkHandles())
    for (const f of LINK_PATTERN_FIELDS)
      if (has(doc, h, f) && doc.get(h, f) === id)
        out.push(`${doc.linkKind(h)} ${doc.id(h)} ${FIELD_LABEL[f]}`);
  if (readOption(doc.data.options, 'defaultPattern')?.[0] === id)
    out.push('the default demand pattern option');
  if (readOption(doc.data.energy, 'globalPattern')?.[0] === id) out.push('the energy price pattern option');
  return out;
}

export function curveUses(doc: Document, id: string): string[] {
  const out: string[] = [];
  for (const h of doc.nodeHandles())
    for (const f of NODE_CURVE_FIELDS)
      if (has(doc, h, f) && doc.get(h, f) === id)
        out.push(`${doc.nodeKind(h)} ${doc.id(h)} ${FIELD_LABEL[f]}`);
  for (const h of doc.linkHandles())
    for (const f of LINK_CURVE_FIELDS)
      if (has(doc, h, f) && doc.get(h, f) === id)
        out.push(`${doc.linkKind(h)} ${doc.id(h)} ${FIELD_LABEL[f]}`);
  return out;
}

function checkNewId(list: readonly { id: string }[], id: string, what: string, except?: string): void {
  const err = validateId(id);
  if (err) throw new EditError(err);
  if (id !== except && list.some((p) => p.id.toUpperCase() === id.toUpperCase()))
    throw new EditError(`A ${what} called ${id} already exists.`);
}

/** The next free numeric ID. */
function nextDataId(list: readonly { id: string }[]): string {
  const taken = new Set(list.map((p) => p.id.toUpperCase()));
  let n = list.length + 1;
  while (taken.has(String(n))) n++;
  return String(n);
}

function checkNumbers(values: readonly number[], what: string): void {
  if (values.some((v) => !Number.isFinite(v))) throw new EditError(`Every ${what} must be a number.`);
}

export function addPattern(store: Store, init: Partial<Pattern> = {}): string {
  const list = store.doc.data.patterns;
  const id = init.id ?? nextDataId(list);
  checkNewId(list, id, 'pattern');
  const multipliers = init.multipliers ?? [1];
  if (multipliers.length === 0) throw new EditError('A pattern needs at least one multiplier.');
  checkNumbers(multipliers, 'multiplier');
  store.transact(`Add pattern ${id}`, (tx) =>
    tx.setDoc('patterns', [...list, { id, comment: init.comment ?? null, multipliers: [...multipliers] }]),
  );
  return id;
}

export function updatePattern(
  store: Store,
  id: string,
  patch: { comment?: string | null; multipliers?: number[] },
): void {
  const list = store.doc.data.patterns;
  const i = list.findIndex((p) => p.id === id);
  if (i < 0) throw new EditError(`There is no pattern ${id}.`);
  if (patch.multipliers) {
    if (patch.multipliers.length === 0) throw new EditError('A pattern needs at least one multiplier.');
    checkNumbers(patch.multipliers, 'multiplier');
  }
  const next = { ...list[i]!, ...patch };
  store.transact(
    `Edit pattern ${id}`,
    (tx) =>
      tx.setDoc(
        'patterns',
        list.map((p, j) => (j === i ? next : p)),
      ),
    {
      coalesce: `pattern:${id}`,
    },
  );
}

function renameInSection(section: KeywordSection, option: string, from: string, to: string): KeywordSection {
  return readOption(section, option)?.[0] === from ? writeOption(section, option, [to]) : section;
}

export function renamePattern(store: Store, from: string, to: string): void {
  const doc = store.doc;
  const list = doc.data.patterns;
  if (!list.some((p) => p.id === from)) throw new EditError(`There is no pattern ${from}.`);
  if (from === to) return;
  checkNewId(list, to, 'pattern', from);
  store.transact(`Rename pattern ${from} to ${to}`, (tx) => {
    tx.setDoc(
      'patterns',
      list.map((p) => (p.id === from ? { ...p, id: to } : p)),
    );
    for (const h of doc.nodeHandles()) {
      for (const f of NODE_PATTERN_FIELDS) if (doc.get(h, f) === from) tx.set(h, f, to);
      const demands = doc.get(h, 'demands') as Demand[] | null;
      if (demands?.some((d) => d.pattern === from))
        tx.set(
          h,
          'demands',
          demands.map((d) => (d.pattern === from ? { ...d, pattern: to } : d)),
        );
      const src = doc.get(h, 'source') as Source | null;
      if (src?.pattern === from) tx.set(h, 'source', { ...src, pattern: to });
    }
    for (const h of doc.linkHandles())
      for (const f of LINK_PATTERN_FIELDS) if (doc.get(h, f) === from) tx.set(h, f, to);
    setIfChanged(tx, doc, 'options', renameInSection(doc.data.options, 'defaultPattern', from, to));
    setIfChanged(tx, doc, 'energy', renameInSection(doc.data.energy, 'globalPattern', from, to));
  });
}

function setIfChanged(tx: Tx, doc: Document, key: 'options' | 'energy', next: KeywordSection): void {
  if (next !== doc.data[key]) tx.setDoc(key, next);
}

export function deletePattern(store: Store, id: string): void {
  const uses = patternUses(store.doc, id);
  if (uses.length > 0) throw new EditError(`Pattern ${id} is used by ${describe(uses)}.`);
  store.transact(`Delete pattern ${id}`, (tx) =>
    tx.setDoc(
      'patterns',
      store.doc.data.patterns.filter((p) => p.id !== id),
    ),
  );
}

function describe(uses: string[]): string {
  return uses.length <= 3 ? uses.join(', ') : `${uses.slice(0, 3).join(', ')} and ${uses.length - 3} more`;
}

export function addCurve(store: Store, init: Partial<Curve> = {}): string {
  const list = store.doc.data.curves;
  const id = init.id ?? nextDataId(list);
  checkNewId(list, id, 'curve');
  const points = init.points ?? [];
  checkNumbers(points.flat(), 'value');
  store.transact(`Add curve ${id}`, (tx) =>
    tx.setDoc('curves', [
      ...list,
      { id, comment: init.comment ?? null, kind: init.kind ?? null, points: points.map((p) => [p[0], p[1]]) },
    ]),
  );
  return id;
}

export function updateCurve(
  store: Store,
  id: string,
  patch: { comment?: string | null; kind?: CurveKind | null; points?: [number, number][] },
): void {
  const list = store.doc.data.curves;
  const i = list.findIndex((c) => c.id === id);
  if (i < 0) throw new EditError(`There is no curve ${id}.`);
  if (patch.points) checkNumbers(patch.points.flat(), 'value');
  const next = { ...list[i]!, ...patch };
  store.transact(
    `Edit curve ${id}`,
    (tx) =>
      tx.setDoc(
        'curves',
        list.map((c, j) => (j === i ? next : c)),
      ),
    {
      coalesce: `curve:${id}`,
    },
  );
}

export function renameCurve(store: Store, from: string, to: string): void {
  const doc = store.doc;
  const list = doc.data.curves;
  if (!list.some((c) => c.id === from)) throw new EditError(`There is no curve ${from}.`);
  if (from === to) return;
  checkNewId(list, to, 'curve', from);
  store.transact(`Rename curve ${from} to ${to}`, (tx) => {
    tx.setDoc(
      'curves',
      list.map((c) => (c.id === from ? { ...c, id: to } : c)),
    );
    for (const h of doc.nodeHandles())
      for (const f of NODE_CURVE_FIELDS) if (doc.get(h, f) === from) tx.set(h, f, to);
    for (const h of doc.linkHandles())
      for (const f of LINK_CURVE_FIELDS) if (doc.get(h, f) === from) tx.set(h, f, to);
  });
}

export function deleteCurve(store: Store, id: string): void {
  const uses = curveUses(store.doc, id);
  if (uses.length > 0) throw new EditError(`Curve ${id} is used by ${describe(uses)}.`);
  store.transact(`Delete curve ${id}`, (tx) =>
    tx.setDoc(
      'curves',
      store.doc.data.curves.filter((c) => c.id !== id),
    ),
  );
}

/**
 * What EPANET will say about a curve used as a given kind, or nothing if it is fine:
 * x values must increase, and a pump curve's heads must fall as flow increases.
 */
export function curveProblem(c: Pick<Curve, 'points' | 'kind'>): string | undefined {
  const p = c.points;
  if (p.length === 0) return 'A curve needs at least one point.';
  for (let i = 1; i < p.length; i++)
    if (p[i]![0] <= p[i - 1]![0]) return `X values must increase (point ${i + 1}).`;
  if (c.kind === 'pump') {
    for (let i = 1; i < p.length; i++)
      if (p[i]![1] >= p[i - 1]![1]) return `Heads must fall as flow increases (point ${i + 1}).`;
  }
  return undefined;
}

/** [CONTROLS] as text, one control per line with its comment after a semicolon. */
export function controlsText(controls: readonly Control[]): string {
  return controls.map((c) => c.tokens.join(' ') + (c.comment ? ` ;${c.comment}` : '')).join('\n');
}

/** Controls from text. Blank and comment-only lines are dropped, as EPANET's reader drops them. */
export function parseControls(text: string): Control[] {
  const out: Control[] = [];
  for (const raw of text.split('\n')) {
    const i = raw.indexOf(';');
    const body = i < 0 ? raw : raw.slice(0, i);
    const tokens = body.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const comment = i < 0 ? null : raw.slice(i + 1).trim() || null;
    out.push({ tokens, comment });
  }
  return out;
}

/** [RULES] as text: each rule's lines as written, a blank line between rules. */
export function rulesText(rules: readonly Rule[]): string {
  return rules.map((r) => r.lines.join('\n')).join('\n\n');
}

/**
 * Rules from text, grouped at each RULE line as EPANET's reader groups them. Throws
 * EditError for a clause before the first RULE line.
 */
export function parseRules(text: string): Rule[] {
  const out: Rule[] = [];
  for (const [n, raw] of text.split('\n').entries()) {
    const line = raw.trimEnd();
    const body = line.split(';')[0]!.trim();
    if (body === '') {
      // Comment lines stay with their rule; blank lines separate rules.
      if (line.trim() !== '' && out.length > 0) out[out.length - 1]!.lines.push(line);
      continue;
    }
    const tokens = body.split(/\s+/);
    if (keywordMatches(tokens[0]!, 'RULE')) out.push({ name: tokens[1] ?? '', lines: [line] });
    else if (out.length > 0) out[out.length - 1]!.lines.push(line);
    else throw new EditError(`Line ${n + 1} comes before the first RULE line.`);
  }
  return out;
}

const USE_KIND: Record<string, CurveKind> = {
  pumpCurve: 'pump',
  efficiencyCurve: 'efficiency',
  volumeCurve: 'volume',
  settingCurve: 'headloss',
  pcvCurve: 'valve',
};

/**
 * A curve's kind: the one written on it (EPANET 2.3), or else the one its first use
 * implies (EPANET 2.2 files record it only in a comment), or null if it is unused.
 */
export function curveKindOf(doc: Document, id: string): CurveKind | null {
  const c = doc.data.curves.find((x) => x.id === id);
  if (c?.kind) return c.kind;
  for (const h of doc.nodeHandles())
    for (const f of NODE_CURVE_FIELDS) if (doc.get(h, f) === id) return USE_KIND[f]!;
  for (const h of doc.linkHandles())
    for (const f of LINK_CURVE_FIELDS) if (doc.get(h, f) === id) return USE_KIND[f]!;
  return null;
}

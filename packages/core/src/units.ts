/**
 * Units. EPANET models are in US customary or SI units, chosen by the flow units
 * option; pressure units can be set separately. The document stores values in the
 * model's own units, as EPANET does, so these functions only label them.
 */

import type { KeywordSection } from './generated/model.ts';
import type { Quantity } from './schema.ts';

export const US_FLOW_UNITS = ['CFS', 'GPM', 'MGD', 'IMGD', 'AFD'] as const;
export const SI_FLOW_UNITS = ['LPS', 'LPM', 'MLD', 'CMH', 'CMD', 'CMS'] as const;
export type FlowUnits = (typeof US_FLOW_UNITS)[number] | (typeof SI_FLOW_UNITS)[number];
export type HeadlossFormula = 'H-W' | 'D-W' | 'C-M';
export type PressureUnits = 'PSI' | 'KPA' | 'METERS' | 'BAR' | 'FEET';

export type QualityKind = 'none' | 'chemical' | 'age' | 'trace';

export interface UnitSystem {
  flow: FlowUnits;
  si: boolean;
  headloss: HeadlossFormula;
  pressure: PressureUnits;
  /** The water-quality analysis and the units its values are in (QUALITY option). */
  quality: { kind: QualityKind; name: string; units: string };
}

/** The QUALITY option as EPANET reads it (`optionchoice`, input3.c). */
export function qualityOf(options: KeywordSection): UnitSystem['quality'] {
  const t = sectionGet(options, ['QUALITY']);
  const t1 = t?.[0];
  if (!t1 || keywordMatches(t1, 'NONE')) return { kind: 'none', name: '', units: '' };
  if (keywordMatches(t1, 'AGE')) return { kind: 'age', name: 'Age', units: 'hrs' };
  if (keywordMatches(t1, 'TRACE')) return { kind: 'trace', name: `Trace ${t[1] ?? ''}`.trim(), units: '%' };
  if (keywordMatches(t1, 'CHEM')) return { kind: 'chemical', name: 'Chemical', units: 'mg/L' };
  return { kind: 'chemical', name: t1, units: t[1] ?? 'mg/L' };
}

/** EPANET's keyword match: case-insensitive, and the token need only begin with the keyword. */
export function keywordMatches(token: string, keyword: string): boolean {
  const t = token.trimStart();
  return t.length >= keyword.length && t.slice(0, keyword.length).toUpperCase() === keyword.toUpperCase();
}

/** Value tokens of the last line whose leading keywords match (`KeywordSection::get`). */
export function sectionGet(section: KeywordSection, keys: readonly string[]): string[] | undefined {
  for (let i = section.lines.length - 1; i >= 0; i--) {
    const line = section.lines[i]!;
    if (line.tokens.length < keys.length) continue;
    if (keys.every((k, j) => keywordMatches(line.tokens[j]!, k))) return line.tokens.slice(keys.length);
  }
  return undefined;
}

const FLOW_KEYWORDS: [string, FlowUnits][] = [
  ['CFS', 'CFS'],
  ['GPM', 'GPM'],
  ['AFD', 'AFD'],
  ['MGD', 'MGD'],
  ['IMGD', 'IMGD'],
  ['LPS', 'LPS'],
  ['LPM', 'LPM'],
  ['CMH', 'CMH'],
  ['CMD', 'CMD'],
  ['MLD', 'MLD'],
  ['CMS', 'CMS'],
  ['SI', 'LPS'],
];

/** The unit system a model's [OPTIONS] select (EPANET's defaults: GPM, H-W). */
export function unitSystem(options: KeywordSection): UnitSystem {
  const u = sectionGet(options, ['UNITS'])?.[0];
  const flow = (u && FLOW_KEYWORDS.find(([k]) => keywordMatches(u, k))?.[1]) || 'GPM';
  const si = (SI_FLOW_UNITS as readonly string[]).includes(flow);
  const hl = sectionGet(options, ['HEADLOSS'])?.[0];
  const headloss: HeadlossFormula =
    hl && keywordMatches(hl, 'D-W') ? 'D-W' : hl && keywordMatches(hl, 'C-M') ? 'C-M' : 'H-W';
  const p = sectionGet(options, ['PRESSURE'])?.[0];
  let pressure: PressureUnits = si ? 'METERS' : 'PSI';
  if (p) {
    for (const k of ['PSI', 'KPA', 'METERS', 'BAR', 'FEET'] as const) if (keywordMatches(p, k)) pressure = k;
  }
  return { flow, si, headloss, pressure, quality: qualityOf(options) };
}

const FLOW_LABEL: Record<FlowUnits, string> = {
  CFS: 'cfs',
  GPM: 'gpm',
  MGD: 'mgd',
  IMGD: 'Imgd',
  AFD: 'ac-ft/d',
  LPS: 'L/s',
  LPM: 'L/min',
  MLD: 'ML/d',
  CMH: 'm³/h',
  CMD: 'm³/d',
  CMS: 'm³/s',
};

const PRESSURE_LABEL: Record<PressureUnits, string> = {
  PSI: 'psi',
  KPA: 'kPa',
  METERS: 'm',
  BAR: 'bar',
  FEET: 'ft',
};

/** Short unit label for a quantity, or '' if it has none. */
export function unitLabel(q: Quantity, u: UnitSystem): string {
  const si = u.si;
  switch (q) {
    case 'elevation':
    case 'length':
    case 'head':
    case 'level':
    case 'tankDiameter':
      return si ? 'm' : 'ft';
    case 'diameter':
      return si ? 'mm' : 'in';
    case 'flow':
      return FLOW_LABEL[u.flow];
    case 'pressure':
      return PRESSURE_LABEL[u.pressure];
    case 'velocity':
      return si ? 'm/s' : 'ft/s';
    case 'roughness':
      return u.headloss === 'D-W' ? (si ? 'mm' : 'mft') : '';
    case 'power':
      return si ? 'kW' : 'hp';
    case 'volume':
      return si ? 'm³' : 'ft³';
    case 'emitter':
      return `${FLOW_LABEL[u.flow]}/${PRESSURE_LABEL[u.pressure]}^½`;
    case 'concentration':
      return u.quality.kind === 'none' ? 'mg/L' : u.quality.units;
    case 'reactionRate':
      return u.quality.kind === 'chemical' ? `${u.quality.units}/d` : '';
    case 'bulkRate':
      return '1/d';
    case 'wallRate':
      return si ? 'm/d' : 'ft/d';
    case 'leakArea':
      return 'mm²';
    case 'leakExpansion':
      return 'mm²/m';
    case 'price':
      return '/kWh';
    case 'none':
      return '';
  }
}

/**
 * Checking results against design criteria (core's `Criteria`): which junctions and
 * pipes break each limit over every report period, and the worst of them. People,
 * agents and the independent checker all use this one check.
 */

import {
  CRITERION_LABEL,
  readQuality,
  type Criteria,
  type Criterion,
  type Document,
} from '@waterstudio/core';
import { linkFrame, nodeFrame, type LinkVariable, type NodeVariable } from '@waterstudio/engine-client';
import type { RunView } from './registry.ts';

export interface Breach {
  id: string;
  value: number;
  /** When the worst value occurs, in hours from the start. */
  atHours: number;
}

export interface CriterionResult {
  criterion: Criterion;
  limit: number;
  /** How many elements break the limit at some report time. */
  elements: number;
  /** The worst of them, worst first. */
  worst: Breach[];
}

export interface Assessment {
  /** Every limit that was checked, met or not. */
  checked: CriterionResult[];
  /** Limits that were set but could not be checked (no quality analysis of that kind). */
  skipped: { criterion: Criterion; reason: string }[];
  /** Whether every checked limit is met. */
  pass: boolean;
}

interface Check {
  table: 'node' | 'link';
  variable: NodeVariable | LinkVariable;
  kind: 'junction' | 'pipe';
  below: boolean;
}

const CHECKS: Record<Criterion, Check> = {
  minPressure: { table: 'node', variable: 'pressure', kind: 'junction', below: true },
  maxPressure: { table: 'node', variable: 'pressure', kind: 'junction', below: false },
  maxVelocity: { table: 'link', variable: 'velocity', kind: 'pipe', below: false },
  maxHeadloss: { table: 'link', variable: 'headloss', kind: 'pipe', below: false },
  minResidual: { table: 'node', variable: 'quality', kind: 'junction', below: true },
  maxAge: { table: 'node', variable: 'quality', kind: 'junction', below: false },
};

function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  const a = Math.abs(v);
  return Number(v.toFixed(a >= 1000 ? 1 : a >= 1 ? 3 : 5));
}

/** Check a run of `doc` against the limits given (any not set are not checked). */
export function assess(
  doc: Document,
  view: Pick<RunView, 'results' | 'nodes' | 'links'>,
  limits: Partial<Criteria>,
  top = 10,
): Assessment {
  const r = view.results;
  const quality = readQuality(doc.data.options).kind;
  const out: Assessment = { checked: [], skipped: [], pass: true };
  for (const [criterion, check] of Object.entries(CHECKS) as [Criterion, Check][]) {
    const limit = limits[criterion];
    if (limit === null || limit === undefined) continue;
    if (criterion === 'minResidual' && quality !== 'chemical') {
      out.skipped.push({ criterion, reason: 'The model does not run a chemical quality analysis.' });
      continue;
    }
    if (criterion === 'maxAge' && quality !== 'age') {
      out.skipped.push({ criterion, reason: 'The model does not run a water age analysis.' });
      continue;
    }
    const handles = check.table === 'node' ? view.nodes : view.links;
    const worst = new Map<number, { value: number; period: number }>();
    for (let p = 0; p < r.times.length; p++) {
      const f =
        check.table === 'node'
          ? nodeFrame(r, check.variable as NodeVariable, p)
          : linkFrame(r, check.variable as LinkVariable, p);
      handles.forEach((h, i) => {
        const x = f[i]!;
        if (!(check.below ? x < limit : x > limit)) return;
        if (!doc.has(h) || doc.kind(h) !== check.kind) return;
        const w = worst.get(h);
        if (!w || (check.below ? x < w.value : x > w.value)) worst.set(h, { value: x, period: p });
      });
    }
    const list = [...worst.entries()]
      .sort((a, b) => (check.below ? a[1].value - b[1].value : b[1].value - a[1].value))
      .slice(0, top)
      .map(([h, w]) => ({
        id: doc.id(h),
        value: round(w.value),
        atHours: (r.reportStart + w.period * r.reportStep) / 3600,
      }));
    out.checked.push({ criterion, limit, elements: worst.size, worst: list });
    if (worst.size > 0) out.pass = false;
  }
  return out;
}

/** One line per broken limit, for a person or a model to read. */
export function describeAssessment(a: Assessment): string[] {
  return a.checked
    .filter((c) => c.elements > 0)
    .map((c) => {
      const w = c.worst[0];
      const kind = c.criterion === 'maxVelocity' || c.criterion === 'maxHeadloss' ? 'pipe' : 'junction';
      const s = c.elements === 1 ? '' : 's';
      return (
        `${CRITERION_LABEL[c.criterion]} ${c.limit}: ${c.elements} ${kind}${s} outside it` +
        (w ? `, worst ${w.id} at ${w.value} (hour ${round(w.atHours)})` : '')
      );
    });
}

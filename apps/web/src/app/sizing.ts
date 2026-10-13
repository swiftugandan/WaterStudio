/**
 * The pipe sizing study (ADR 0022): least-cost sizes for a set of pipes against the
 * design criteria and, for fire-flow repair, the junctions that cannot supply a fire
 * flow. The result goes to the Proposals queue like an agent's, through the same
 * submission and independent check.
 */

import { criteriaLimits, draftContext, setValues, submitDraft } from '@waterstudio/agents';
import { CRITERION_LABEL, type Criterion } from '@waterstudio/core';
import type { FireFlowOptions, PipeSize, SizingOptions, SizingResult } from '@waterstudio/engine-client';
import { agentHost } from './assistant.ts';
import type { AppState } from './state.ts';
import { runFireFlow, studyPool } from './studies.ts';

export interface SizingRequest {
  pipes: string[];
  sizes: PipeSize[];
  /** Check the design criteria (pressure, velocity, head loss) over the simulation. */
  criteria: boolean;
  /** Fire flow every junction must supply (the hydrants are those that cannot now). */
  fire: Omit<FireFlowOptions, 'hydrants'> | null;
  asNew: boolean;
}

export interface SizingRun {
  request: SizingRequest;
  /** The hydrants that failed the fire flow study and were sized for. */
  hydrants: string[];
  result: SizingResult | null;
  /** Why nothing was sized, when nothing needed to be. */
  note: string | null;
  /** The revision of the network it was run on. */
  rev: number;
}

/** Sizes and costs typed one per line, `diameter cost`; the first error found, or the list. */
export function parseSizes(text: string): PipeSize[] | string {
  const out: PipeSize[] = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.replace(/[,;\t]/g, ' ').trim();
    if (!line) continue;
    const [d, c, extra] = line.split(/\s+/);
    const diameter = Number(d);
    const unitCost = Number(c);
    if (extra !== undefined || !(diameter > 0) || !(unitCost >= 0) || !Number.isFinite(unitCost))
      return `Line ${i + 1}: write a diameter and a cost per unit length, such as "12 90".`;
    if (out.some((s) => s.diameter === diameter)) return `Line ${i + 1}: size ${diameter} is listed twice.`;
    out.push({ diameter, unitCost });
  }
  if (out.length === 0) return 'List at least one size with its cost.';
  return out.sort((a, b) => a.diameter - b.diameter);
}

/** Illustrative sizes and installed costs per unit length, to edit. */
export function defaultSizes(si: boolean): string {
  const rows = si
    ? [
        [100, 120],
        [150, 160],
        [200, 190],
        [250, 230],
        [300, 280],
        [350, 340],
        [400, 400],
        [450, 460],
        [500, 520],
        [600, 640],
      ]
    : [
        [4, 40],
        [6, 50],
        [8, 60],
        [10, 75],
        [12, 90],
        [14, 110],
        [16, 130],
        [18, 150],
        [20, 170],
        [24, 210],
      ];
  return rows.map(([d, c]) => `${d} ${c}`).join('\n');
}

export async function runSizing(
  state: AppState,
  request: SizingRequest,
  progress: (done: number, total: number) => void,
): Promise<SizingRun> {
  const rev = state.store.rev;
  const doc = state.store.doc;
  const limits = request.criteria ? criteriaLimits(doc) : {};
  if (request.criteria && Object.keys(limits).length === 0 && !request.fire)
    throw new Error('No pressure, velocity or head loss criteria are set; set them in Options, Criteria.');
  if (!request.criteria && !request.fire)
    throw new Error('Size for the design criteria, a fire flow, or both.');
  let hydrants: string[] = [];
  if (request.fire) {
    const all = [...doc.nodeHandles()].filter((h) => doc.kind(h) === 'junction').map((h) => doc.id(h));
    const ff = await runFireFlow(state.sync, { ...request.fire, hydrants: all }, progress);
    hydrants = ff.filter((r) => !r.meets).map((r) => r.id);
    if (hydrants.length === 0 && Object.keys(limits).length === 0)
      return { request, hydrants, result: null, note: 'Every junction already supplies the fire flow.', rev };
  }
  const options: SizingOptions = {
    pipes: request.pipes,
    sizes: request.sizes,
    limits,
    ...(hydrants.length > 0 && request.fire ? { fire: { ...request.fire, hydrants } } : {}),
    ...(request.asNew ? { fromSmallest: true } : {}),
  };
  const r = await studyPool().study({ kind: 'sizing', model: state.sync, options });
  return { request, hydrants, result: r.value, note: null, rev };
}

/** Put a sizing result in the Proposals queue; returns the proposal's ID. */
export async function proposeSizing(state: AppState, run: SizingRun): Promise<string> {
  const result = run.result;
  if (!result || result.changes.length === 0) throw new Error('The study changes no pipe.');
  if (run.rev !== state.store.rev) throw new Error('The network has changed since the study; run it again.');
  const ctx = draftContext(agentHost(state, 'Pipe sizing study'));
  for (const c of result.changes) {
    const h = ctx.doc.findLink(c.id);
    if (h !== undefined) setValues(ctx, h, { diameter: c.to });
  }
  const aims = [
    run.request.criteria ? 'the design criteria' : null,
    run.hydrants.length > 0 ? `fire flow at ${run.hydrants.length} junction(s)` : null,
  ].filter(Boolean);
  const sized: Criterion[] = run.request.criteria
    ? ['minPressure', 'maxPressure', 'maxVelocity', 'maxHeadloss']
    : [];
  const r = await submitDraft(ctx, {
    title: `Pipe sizing: ${result.changes.length} pipe(s) for ${aims.join(' and ')}`,
    rationale:
      `Least-cost sizes from the pipe sizing study for ${aims.join(' and ')}, from ${run.request.sizes.length} ` +
      `standard sizes; cost ${Math.round(result.cost).toLocaleString('en-US')}. ` +
      (result.meets
        ? 'Every limit sized for is met.'
        : `It stops short: ${result.stopped ?? 'a limit is still broken'}.`),
    explain: (c) =>
      sized.includes(c)
        ? `The sizing study could not meet ${CRITERION_LABEL[c].toLowerCase()} with the sizes given.`
        : 'Not part of this sizing study.',
  });
  return String(r['proposal']);
}

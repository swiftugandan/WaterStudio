/**
 * Design tools (ADR 0022): least-cost pipe sizing and fire-flow repair. Both run the
 * engine's sizing study on the draft and, unless told not to, set the diameters it
 * finds in the draft, ready to check and submit as a proposal like any other edit.
 */

import { CRITERION_LABEL, unitLabel, type Document, type UnitSystem } from '@waterstudio/core';
import type { SizingBreach, SizingLimits, SizingOptions, SizingResult } from '@waterstudio/engine-client';
import { draftOf, setValues } from './draft.ts';
import { defineTool, type AgentContext, type Tool } from './registry.ts';
import { junctionIds } from './tools.ts';

interface SizeArg {
  diameter: number;
  unit_cost: number;
}

const sizesSchema = {
  type: 'array',
  minItems: 1,
  maxItems: 60,
  description:
    "The standard sizes available, in the model's diameter units, each with its installed cost per unit length " +
    '(per foot or metre, any currency). Only these sizes are used.',
  items: {
    type: 'object',
    properties: {
      diameter: { type: 'number', minimum: 0 },
      unit_cost: { type: 'number', minimum: 0 },
    },
    required: ['diameter', 'unit_cost'],
    additionalProperties: false,
  },
} as const;

const pipesSchema = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 20000,
  description: 'IDs of the pipes that may be resized (default: every pipe).',
} as const;

/** Pipe IDs, or every pipe; anything else is refused. */
function pipeIds(doc: Document, ids: readonly string[] | undefined): string[] {
  if (!ids) return [...doc.linkHandles()].filter((h) => doc.kind(h) === 'pipe').map((h) => doc.id(h));
  const bad = ids.filter((id) => {
    const h = doc.findLink(id);
    return h === undefined || doc.kind(h) !== 'pipe';
  });
  if (bad.length > 0) throw new Error(`These are not pipes: ${bad.slice(0, 20).join(', ')}.`);
  if (ids.length === 0) throw new Error('Name at least one pipe.');
  return [...new Set(ids)];
}

const BREACH_LABEL: Record<SizingBreach['kind'], string> = {
  ...CRITERION_LABEL,
  fireResidual: 'Residual pressure at the hydrant',
  fireSystem: 'Pressure elsewhere during a fire flow',
};

function units(u: UnitSystem) {
  return {
    diameter: unitLabel('diameter', u),
    length: unitLabel('length', u),
    pressure: unitLabel('pressure', u),
    velocity: unitLabel('velocity', u),
    headloss: u.si ? 'm/km' : 'ft/kft',
    cost: `per ${unitLabel('length', u)} as given`,
  };
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

function breaches(list: SizingBreach[], n: number) {
  return list.slice(0, n).map((b) => ({
    limit: BREACH_LABEL[b.kind],
    id: b.id,
    value: r3(b.value),
    allowed: b.limit,
    ...(b.hydrant && b.hydrant !== b.id ? { duringFireAt: b.hydrant } : {}),
  }));
}

/** Run the sizing study on the draft and, if asked, set the sizes found in it. */
async function size(
  ctx: AgentContext,
  options: SizingOptions,
  apply: boolean,
): Promise<{ result: SizingResult; reply: Record<string, unknown> }> {
  const d = draftOf(ctx);
  if (!ctx.study) throw new Error('Studies are not available in this session.');
  const result = await ctx.study({ kind: 'sizing', options });
  const set = apply && result.changes.length > 0;
  if (set)
    for (const c of result.changes) {
      const h = d.doc.findLink(c.id);
      if (h !== undefined) setValues(d, h, { diameter: c.to });
    }
  return {
    result,
    reply: {
      meets: result.meets,
      ...(result.stopped ? { stopped: result.stopped } : {}),
      cost: Math.round(result.cost),
      units: units(ctx.units),
      changes: result.changes.slice(0, 200).map((c) => ({
        pipe: c.id,
        from: c.from,
        to: c.to,
        length: r3(c.length),
        cost: Math.round(c.cost),
      })),
      ...(result.changes.length > 200 ? { moreChanges: result.changes.length - 200 } : {}),
      applied: set,
      breachesBefore: result.breachesBefore,
      worstBefore: breaches(result.before, 10),
      breachesAfter: result.breachesAfter,
      worstAfter: breaches(result.after, 10),
      solutions: result.solutions,
      draftChanges: d.sandbox().changes().length,
    },
  };
}

function sizeOptions(
  doc: Document,
  args: { pipes?: string[]; sizes: SizeArg[]; as_new?: boolean; max_solutions?: number },
): Omit<SizingOptions, 'limits' | 'fire'> {
  return {
    pipes: pipeIds(doc, args.pipes),
    sizes: args.sizes.map((s) => ({ diameter: s.diameter, unitCost: s.unit_cost })),
    ...(args.as_new ? { fromSmallest: true } : {}),
    ...(args.max_solutions ? { maxSolutions: args.max_solutions } : {}),
  };
}

/** The project's hydraulic design criteria (pressure, velocity, head loss) as sizing limits. */
export function criteriaLimits(doc: Document): SizingLimits {
  const c = doc.data.criteria;
  const out: SizingLimits = {};
  if (c.minPressure !== null) out.minPressure = c.minPressure;
  if (c.maxPressure !== null) out.maxPressure = c.maxPressure;
  if (c.maxVelocity !== null) out.maxVelocity = c.maxVelocity;
  if (c.maxHeadloss !== null) out.maxHeadloss = c.maxHeadloss;
  return out;
}

export const sizePipes = defineTool<{
  pipes?: string[];
  sizes: SizeArg[];
  limits?: { min_pressure?: number; max_pressure?: number; max_velocity?: number; max_headloss?: number };
  as_new?: boolean;
  apply?: boolean;
  max_solutions?: number;
}>({
  name: 'size_pipes',
  description:
    'Least-cost pipe sizing in your draft: choose standard sizes for the pipes so that every junction pressure, ' +
    "pipe velocity and unit head loss limit holds at every report time, at the least cost. Limits default to the project's " +
    'design criteria. Existing pipes keep their size at no cost or are replaced by a larger one; with as_new, ' +
    'the pipes are sized as new from the smallest size and all are costed. The engine searches step by step ' +
    '(the size that removes most shortfall per cost, then trims what is not needed). The sizes found are set ' +
    'in your draft unless apply is false; check and submit them as usual.',
  input: {
    type: 'object',
    properties: {
      pipes: pipesSchema,
      sizes: sizesSchema,
      limits: {
        type: 'object',
        description: "Limits in the model's units, in place of the design criteria.",
        properties: {
          min_pressure: { type: 'number' },
          max_pressure: { type: 'number' },
          max_velocity: { type: 'number', minimum: 0 },
          max_headloss: { type: 'number', minimum: 0 },
        },
        additionalProperties: false,
      },
      as_new: { type: 'boolean' },
      apply: { type: 'boolean', description: 'Set the sizes found in the draft (default true).' },
      max_solutions: { type: 'integer', minimum: 10, maximum: 20000 },
    },
    required: ['sizes'],
    additionalProperties: false,
  },
  scope: 'draft',
  run: async (args, ctx) => {
    const doc = draftOf(ctx).doc;
    const l = args.limits;
    const limits: SizingLimits = l
      ? {
          ...(l.min_pressure !== undefined ? { minPressure: l.min_pressure } : {}),
          ...(l.max_pressure !== undefined ? { maxPressure: l.max_pressure } : {}),
          ...(l.max_velocity !== undefined ? { maxVelocity: l.max_velocity } : {}),
          ...(l.max_headloss !== undefined ? { maxHeadloss: l.max_headloss } : {}),
        }
      : criteriaLimits(doc);
    if (Object.keys(limits).length === 0)
      throw new Error(
        'There are no limits to size for: give limits, or set the design criteria (pressure, velocity or head loss).',
      );
    const { reply } = await size(ctx, { ...sizeOptions(doc, args), limits }, args.apply ?? true);
    return { limits, ...reply };
  },
});

export const repairFireFlow = defineTool<{
  hydrants?: string[];
  flow: number;
  residual: number;
  system_min?: number;
  time_hours?: number;
  pipes?: string[];
  sizes: SizeArg[];
  with_criteria?: boolean;
  apply?: boolean;
  max_solutions?: number;
}>({
  name: 'repair_fire_flow',
  description:
    'Fire-flow repair in your draft: the least-cost pipe enlargements (from the standard sizes given) that let ' +
    'every hydrant deliver the design fire flow with the residual pressure (and system_min elsewhere). Hydrants ' +
    'default to those that fail a fire flow study now. With with_criteria, the design criteria must also hold ' +
    'over the whole simulation. The sizes found are set in your draft unless apply is false.',
  input: {
    type: 'object',
    properties: {
      hydrants: { type: 'array', items: { type: 'string' }, maxItems: 5000 },
      flow: { type: 'number', minimum: 0, description: 'Design fire flow.' },
      residual: { type: 'number' },
      system_min: { type: 'number' },
      time_hours: { type: 'number', minimum: 0 },
      pipes: pipesSchema,
      sizes: sizesSchema,
      with_criteria: { type: 'boolean' },
      apply: { type: 'boolean', description: 'Set the sizes found in the draft (default true).' },
      max_solutions: { type: 'integer', minimum: 10, maximum: 20000 },
    },
    required: ['flow', 'residual', 'sizes'],
    additionalProperties: false,
  },
  scope: 'draft',
  run: async (args, ctx) => {
    const doc = draftOf(ctx).doc;
    if (!ctx.study) throw new Error('Studies are not available in this session.');
    if (!(args.flow > 0)) throw new Error('The fire flow must be more than 0.');
    const time = Math.round((args.time_hours ?? 0) * 3600);
    const fire = {
      flow: args.flow,
      residual: args.residual,
      ...(args.system_min !== undefined ? { systemMin: args.system_min } : {}),
      time,
    };
    let hydrants = args.hydrants ? junctionIds(doc, args.hydrants) : null;
    if (!hydrants) {
      const study = await ctx.study({
        kind: 'fireFlow',
        options: { hydrants: junctionIds(doc, undefined), ...fire },
      });
      hydrants = study.filter((r) => !r.meets).map((r) => r.id);
      if (hydrants.length === 0)
        return { meets: true, applied: false, message: 'Every junction already delivers the fire flow.' };
    }
    if (hydrants.length === 0) throw new Error('Name at least one hydrant.');
    const limits = args.with_criteria ? criteriaLimits(doc) : {};
    const { reply } = await size(
      ctx,
      { ...sizeOptions(doc, args), limits, fire: { hydrants, ...fire } },
      args.apply ?? true,
    );
    return { hydrants: hydrants.slice(0, 200), ...reply };
  },
});

export const DESIGN_TOOLS: Tool<never>[] = [sizePipes, repairFireFlow] as Tool<never>[];

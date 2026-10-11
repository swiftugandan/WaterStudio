/**
 * Read-only tools: they describe the model and its results and run analyses, but never
 * change the model. Answers are summaries, statistics, top-k lists and pages addressed
 * by element ID, never the whole network, so they fit a model's context.
 */

import {
  fieldsOf,
  keywordMatches,
  LINK_KINDS,
  NODE_KINDS,
  sectionGet,
  unitLabel,
  type Document,
  type ElementKind,
  type FieldSpec,
} from '@waterstudio/core';
import {
  LINK_VARIABLES,
  NODE_VARIABLES,
  linkFrame,
  nodeFrame,
  type LinkVariable,
  type NodeVariable,
  type RunResults,
} from '@waterstudio/engine-client';
import { matches, parseQuery, queryFields, QueryError, type Value } from './query.ts';
import { defineTool, type AgentContext, type RunView, type Tool } from './registry.ts';

export const WARNINGS: Record<number, string> = {
  1: 'the system is hydraulically unbalanced',
  2: 'the system may be hydraulically unstable',
  4: 'pumps cannot deliver enough flow or head',
  5: 'valves cannot deliver enough flow or pressure',
  6: 'the system has negative pressures',
};

type Table = 'node' | 'link';
const isNodeVar = (v: string): v is NodeVariable => (NODE_VARIABLES as readonly string[]).includes(v);
const isLinkVar = (v: string): v is LinkVariable => (LINK_VARIABLES as readonly string[]).includes(v);

/** A readable value of a catalogue field: option names for enums, IDs for node references. */
export function fieldValue(doc: Document, h: number, spec: FieldSpec): unknown {
  const v = doc.get(h, spec.name);
  if (spec.editor.type === 'enum' && typeof v === 'number') return spec.editor.options[v] ?? v;
  if (spec.editor.type === 'node' && typeof v === 'number') return doc.has(v) ? doc.id(v) : null;
  if (typeof v === 'number' && Number.isNaN(v)) return null;
  return v;
}

function round(v: number): number {
  if (!Number.isFinite(v)) return v;
  const a = Math.abs(v);
  const digits = a >= 1000 ? 1 : a >= 1 ? 3 : 5;
  return Number(v.toFixed(digits));
}

function hours(r: RunResults, p: number): number {
  return (r.reportStart + p * r.reportStep) / 3600;
}

function needResults(ctx: AgentContext): RunView {
  const r = ctx.results();
  if (!r) throw new Error('There are no results yet. Call run_analysis first.');
  return r;
}

function periodOf(r: RunResults, ctx: AgentContext, p: number | undefined): number {
  const n = r.times.length;
  const v = p ?? ctx.period();
  if (v < 0 || v >= n) throw new Error(`period must be between 0 and ${n - 1}`);
  return v;
}

function* elements(doc: Document, table: Table | 'any'): Generator<number> {
  if (table !== 'link') yield* doc.nodeHandles();
  if (table !== 'node') yield* doc.linkHandles();
}

/** Column of each handle in a run, built once per run. */
const columns = new WeakMap<Uint32Array, Map<number, number>>();
function columnOf(handles: Uint32Array, h: number): number {
  let m = columns.get(handles);
  if (!m) {
    m = new Map();
    handles.forEach((x, i) => m!.set(x, i));
    columns.set(handles, m);
  }
  return m.get(h) ?? -1;
}

function resultOf(
  view: RunView | null,
  doc: Document,
  h: number,
  variable: string,
  period: number,
): number | undefined {
  if (!view) return undefined;
  const r = view.results;
  if (doc.isNode(h)) {
    // Results decoded from an older engine may lack a variable.
    if (!isNodeVar(variable) || !(variable in r.node)) return undefined;
    const c = columnOf(view.nodes, h);
    return c < 0 ? undefined : nodeFrame(r, variable, period)[c];
  }
  if (!isLinkVar(variable) || !(variable in r.link)) return undefined;
  const c = columnOf(view.links, h);
  return c < 0 ? undefined : linkFrame(r, variable, period)[c];
}

/** Every name a query or field list may use, with how to read it. */
function reader(doc: Document, view: RunView | null, period: number) {
  const specs = new Map<ElementKind, Map<string, FieldSpec>>();
  for (const k of [...NODE_KINDS, ...LINK_KINDS]) {
    specs.set(k, new Map(fieldsOf(k).map((s) => [s.name.toLowerCase(), s])));
  }
  return (h: number, name: string): Value | undefined => {
    const n = name.toLowerCase();
    if (n === 'type') return doc.kind(h);
    if (n === 'id') return doc.id(h);
    if (n === 'table') return doc.isNode(h) ? 'node' : 'link';
    const spec = specs.get(doc.kind(h))?.get(n);
    if (spec && spec.editor.type !== 'none') {
      const v = fieldValue(doc, h, spec);
      return typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' || v === null
        ? v
        : undefined;
    }
    if (n === 'demand' && doc.nodeKind(h) === 'junction' && !view) {
      const d = doc.get(h, 'demands') as { base: number }[];
      return d.reduce((a, x) => a + x.base, 0);
    }
    const r = resultOf(view, doc, h, n, period);
    return r === undefined ? undefined : round(r);
  };
}

function knownName(name: string): boolean {
  const n = name.toLowerCase();
  if (['type', 'id', 'table'].includes(n) || isNodeVar(n) || isLinkVar(n)) return true;
  return [...NODE_KINDS, ...LINK_KINDS].some((k) => fieldsOf(k).some((s) => s.name.toLowerCase() === n));
}

const tableSchema = {
  type: 'string',
  enum: ['node', 'link', 'any'],
  description: 'Nodes, links or both.',
} as const;
const periodSchema = {
  type: 'integer',
  minimum: 0,
  description: 'Report period index (0 is the first report time). Defaults to the time the user is viewing.',
} as const;

export const getProjectSummary = defineTool<Record<string, never>>({
  name: 'get_project_summary',
  description:
    'Overview of the open network: element counts by type, units, head-loss formula, quality analysis, ' +
    'simulation times, coordinate system and whether results exist. Call this first.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  scope: 'read',
  run: (_args, ctx) => {
    const doc = ctx.doc;
    const counts: Record<string, number> = {};
    for (const h of elements(doc, 'any')) counts[doc.kind(h)] = (counts[doc.kind(h)] ?? 0) + 1;
    const opt = (k: string) => sectionGet(doc.data.times, [k])?.join(' ');
    const u = ctx.units;
    const view = ctx.results();
    const crs = doc.data.backdrop.lines.find((l) => l.tokens[0] && keywordMatches(l.tokens[0], 'CRS'));
    return {
      file: ctx.fileName,
      title: doc.data.title.slice(0, 3),
      counts,
      patterns: doc.data.patterns.length,
      curves: doc.data.curves.length,
      controls: doc.data.controls.length,
      rules: doc.data.rules.length,
      units: {
        flow: u.flow,
        pressure: unitLabel('pressure', u),
        length: unitLabel('length', u),
        diameter: unitLabel('diameter', u),
        elevation: unitLabel('elevation', u),
        velocity: unitLabel('velocity', u),
        quality: u.quality.units || null,
      },
      headloss: u.headloss,
      quality: u.quality.kind === 'none' ? 'none' : u.quality.name,
      times: { duration: opt('DURATION') ?? '0', hydraulicStep: opt('HYDRAULIC'), reportStep: opt('REPORT') },
      coordinateSystem: crs ? crs.tokens.slice(1).join(' ') : null,
      results: view
        ? {
            periods: view.results.times.length,
            reportStepHours: view.results.reportStep / 3600,
            stale: view.stale,
            warning: WARNINGS[view.results.warning] ?? null,
          }
        : null,
    };
  },
});

export const queryElements = defineTool<{
  query?: string;
  table?: Table | 'any';
  fields?: string[];
  period?: number;
  limit?: number;
  offset?: number;
}>({
  name: 'query_elements',
  description:
    'Find elements with a query such as `type = junction and pressure < 20` or `diameter <= 150`. ' +
    'Names are element fields (elevation, diameter, length, roughness, status...), `type`, `id`, and result ' +
    'variables (demand, head, pressure, quality, flow, velocity, headloss, status, setting...) at the given ' +
    'period. Comparisons: < <= > >= = !=, combined with and/or/not and parentheses. Values are in the ' +
    "model's units. Returns the total count and a page of matches with the requested fields.",
  input: {
    type: 'object',
    properties: {
      query: { type: 'string', maxLength: 500, description: 'The query; omit to list everything.' },
      table: tableSchema,
      fields: {
        type: 'array',
        items: { type: 'string', maxLength: 40 },
        maxItems: 12,
        description: 'Fields or result variables to return for each match.',
      },
      period: periodSchema,
      limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Page size (default 50).' },
      offset: { type: 'integer', minimum: 0, description: 'Matches to skip, for paging.' },
    },
    additionalProperties: false,
  },
  scope: 'read',
  run: (args, ctx) => {
    let q;
    try {
      q = args.query ? parseQuery(args.query) : null;
    } catch (e) {
      throw new Error(`Query error: ${e instanceof QueryError ? e.message : String(e)}`, { cause: e });
    }
    const names = [...(q ? queryFields(q) : []), ...(args.fields ?? [])];
    const unknown = names.filter((n) => !knownName(n));
    if (unknown.length > 0) throw new Error(`Unknown field or variable: ${[...new Set(unknown)].join(', ')}`);
    const view = ctx.results();
    const period = view ? periodOf(view.results, ctx, args.period) : 0;
    const read = reader(ctx.doc, view, period);
    const limit = args.limit ?? 50;
    const offset = args.offset ?? 0;
    let total = 0;
    const page: Record<string, unknown>[] = [];
    for (const h of elements(ctx.doc, args.table ?? 'any')) {
      if (q && !matches(q, (f) => read(h, f))) continue;
      if (total >= offset && page.length < limit) {
        const row: Record<string, unknown> = { id: ctx.doc.id(h), type: ctx.doc.kind(h) };
        for (const f of args.fields ?? []) row[f] = read(h, f) ?? null;
        page.push(row);
      }
      total++;
    }
    return {
      total,
      offset,
      returned: page.length,
      ...(view ? { atHours: hours(view.results, period) } : {}),
      elements: page,
    };
  },
});

export const getElement = defineTool<{ id: string; table?: Table; period?: number }>({
  name: 'get_element',
  description:
    'Every property of one element by ID (fields with units, connections for links), and its results at ' +
    'the given period when results exist.',
  input: {
    type: 'object',
    properties: {
      id: { type: 'string', maxLength: 64, description: 'The element ID.' },
      table: {
        type: 'string',
        enum: ['node', 'link'],
        description: 'Needed only when a node and a link share the ID.',
      },
      period: periodSchema,
    },
    required: ['id'],
    additionalProperties: false,
  },
  scope: 'read',
  run: (args, ctx) => {
    const doc = ctx.doc;
    const h =
      args.table === 'link' ? doc.findLink(args.id) : (doc.findNode(args.id) ?? doc.findLink(args.id));
    if (h === undefined) throw new Error(`No element has ID ${args.id}.`);
    const out: Record<string, unknown> = { id: doc.id(h), type: doc.kind(h) };
    const units: Record<string, string> = {};
    for (const s of fieldsOf(doc.kind(h))) {
      if (s.editor.type === 'none' || s.name === 'id') continue;
      const v = fieldValue(doc, h, s);
      if (v === null || v === undefined || v === '') continue;
      out[s.name] = v;
      const unit = unitLabel(s.quantity, ctx.units);
      if (unit) units[s.name] = unit;
    }
    if (doc.isNode(h)) out['links'] = doc.linksAt(h).map((l) => doc.id(l));
    out['units'] = units;
    const view = ctx.results();
    if (view) {
      const period = periodOf(view.results, ctx, args.period);
      const res: Record<string, number> = {};
      for (const v of doc.isNode(h) ? NODE_VARIABLES : LINK_VARIABLES) {
        const x = resultOf(view, doc, h, v, period);
        if (x !== undefined) res[v] = round(x);
      }
      out['results'] = { atHours: hours(view.results, period), stale: view.stale, ...res };
    }
    return out;
  },
});

function stats(values: number[]) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (f: number) => v[Math.min(v.length - 1, Math.floor(f * (v.length - 1)))]!;
  return {
    count: v.length,
    min: round(v[0]!),
    p10: round(q(0.1)),
    median: round(q(0.5)),
    p90: round(q(0.9)),
    max: round(v[v.length - 1]!),
    mean: round(v.reduce((a, b) => a + b, 0) / v.length),
  };
}

export const getResultsSlice = defineTool<{
  variable: string;
  table?: Table;
  period?: number;
  top?: number;
  types?: string[];
}>({
  name: 'get_results_slice',
  description:
    'Statistics of one result variable over all nodes or links at one period (count, min, percentiles, ' +
    'mean, max) and the elements with the lowest and highest values.',
  input: {
    type: 'object',
    properties: {
      variable: {
        type: 'string',
        maxLength: 20,
        description: 'A node or link result variable, e.g. pressure or velocity.',
      },
      table: {
        type: 'string',
        enum: ['node', 'link'],
        description: 'Inferred from the variable when it is unambiguous.',
      },
      period: periodSchema,
      top: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'How many lowest and highest to list (default 5).',
      },
      types: {
        type: 'array',
        items: { type: 'string', enum: [...NODE_KINDS, ...LINK_KINDS] },
        maxItems: 6,
        description: 'Only these element types (e.g. ["junction"] for pressures at consumers).',
      },
    },
    required: ['variable'],
    additionalProperties: false,
  },
  scope: 'read',
  run: (args, ctx) => {
    const view = needResults(ctx);
    const v = args.variable.toLowerCase();
    const table: Table = args.table ?? (isNodeVar(v) && !isLinkVar(v) ? 'node' : 'link');
    if (table === 'node' ? !isNodeVar(v) : !isLinkVar(v))
      throw new Error(`${v} is not a ${table} result variable.`);
    const period = periodOf(view.results, ctx, args.period);
    const frame =
      table === 'node'
        ? nodeFrame(view.results, v as NodeVariable, period)
        : linkFrame(view.results, v as LinkVariable, period);
    const handles = table === 'node' ? view.nodes : view.links;
    const doc = ctx.doc;
    const rows: { id: string; type: string; value: number }[] = [];
    handles.forEach((h, i) => {
      if (!doc.has(h)) return;
      if (args.types && !args.types.includes(doc.kind(h))) return;
      rows.push({ id: doc.id(h), type: doc.kind(h), value: round(frame[i]!) });
    });
    rows.sort((a, b) => a.value - b.value);
    const k = args.top ?? 5;
    return {
      variable: v,
      atHours: hours(view.results, period),
      stale: view.stale,
      stats: stats(rows.map((r) => r.value)),
      lowest: rows.slice(0, k),
      highest: rows.slice(-k).reverse(),
    };
  },
});

export const getTimeseries = defineTool<{ ids: string[]; variable: string; table?: Table }>({
  name: 'get_timeseries',
  description: 'A result variable over every report period for up to 10 elements.',
  input: {
    type: 'object',
    properties: {
      ids: { type: 'array', items: { type: 'string', maxLength: 64 }, minItems: 1, maxItems: 10 },
      variable: { type: 'string', maxLength: 20 },
      table: { type: 'string', enum: ['node', 'link'] },
    },
    required: ['ids', 'variable'],
    additionalProperties: false,
  },
  scope: 'read',
  run: (args, ctx) => {
    const view = needResults(ctx);
    const r = view.results;
    const doc = ctx.doc;
    const v = args.variable.toLowerCase();
    const n = r.times.length;
    const step = Math.max(1, Math.ceil(n / 200));
    const idx = Array.from({ length: Math.ceil(n / step) }, (_, i) => i * step);
    const series: Record<string, number[]> = {};
    for (const id of args.ids) {
      const h = args.table === 'link' ? doc.findLink(id) : (doc.findNode(id) ?? doc.findLink(id));
      if (h === undefined) throw new Error(`No element has ID ${id}.`);
      if (resultOf(view, doc, h, v, 0) === undefined)
        throw new Error(`${v} is not a result variable of ${doc.kind(h)} ${id}.`);
      series[id] = idx.map((p) => round(resultOf(view, doc, h, v, p)!));
    }
    return {
      variable: v,
      hours: idx.map((p) => hours(r, p)),
      ...(step > 1 ? { note: `every ${step}th of ${n} periods` } : {}),
      stale: view.stale,
      series,
    };
  },
});

export const findViolations = defineTool<{
  min_pressure?: number;
  max_pressure?: number;
  max_velocity?: number;
  max_headloss?: number;
  top?: number;
}>({
  name: 'find_violations',
  description:
    'Check results against design limits over every report period: junction pressures below a minimum or ' +
    "above a maximum, pipe velocities and unit head losses above a maximum. Values are in the model's units. " +
    'For each limit: how many elements break it, and the worst ones with the time it happens.',
  input: {
    type: 'object',
    properties: {
      min_pressure: { type: 'number' },
      max_pressure: { type: 'number' },
      max_velocity: { type: 'number', minimum: 0 },
      max_headloss: { type: 'number', minimum: 0, description: 'Unit head loss per 1000 length units.' },
      top: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Worst elements to list per limit (default 10).',
      },
    },
    additionalProperties: false,
  },
  scope: 'read',
  run: (args, ctx) => {
    const view = needResults(ctx);
    const r = view.results;
    const doc = ctx.doc;
    const k = args.top ?? 10;
    type Check = {
      name: string;
      table: Table;
      variable: string;
      kinds: string[];
      limit: number;
      below: boolean;
    };
    const checks: Check[] = [];
    if (args.min_pressure !== undefined)
      checks.push({
        name: 'min_pressure',
        table: 'node',
        variable: 'pressure',
        kinds: ['junction'],
        limit: args.min_pressure,
        below: true,
      });
    if (args.max_pressure !== undefined)
      checks.push({
        name: 'max_pressure',
        table: 'node',
        variable: 'pressure',
        kinds: ['junction'],
        limit: args.max_pressure,
        below: false,
      });
    if (args.max_velocity !== undefined)
      checks.push({
        name: 'max_velocity',
        table: 'link',
        variable: 'velocity',
        kinds: ['pipe'],
        limit: args.max_velocity,
        below: false,
      });
    if (args.max_headloss !== undefined)
      checks.push({
        name: 'max_headloss',
        table: 'link',
        variable: 'headloss',
        kinds: ['pipe'],
        limit: args.max_headloss,
        below: false,
      });
    if (checks.length === 0) throw new Error('Give at least one limit.');
    const out: Record<string, unknown> = { stale: view.stale };
    for (const c of checks) {
      const handles = c.table === 'node' ? view.nodes : view.links;
      const worst = new Map<number, { value: number; period: number }>();
      for (let p = 0; p < r.times.length; p++) {
        const f =
          c.table === 'node'
            ? nodeFrame(r, c.variable as NodeVariable, p)
            : linkFrame(r, c.variable as LinkVariable, p);
        handles.forEach((h, i) => {
          const x = f[i]!;
          if (!(c.below ? x < c.limit : x > c.limit)) return;
          if (!doc.has(h) || !c.kinds.includes(doc.kind(h))) return;
          const w = worst.get(h);
          if (!w || (c.below ? x < w.value : x > w.value)) worst.set(h, { value: x, period: p });
        });
      }
      const list = [...worst.entries()]
        .sort((a, b) => (c.below ? a[1].value - b[1].value : b[1].value - a[1].value))
        .slice(0, k)
        .map(([h, w]) => ({ id: doc.id(h), value: round(w.value), atHours: hours(r, w.period) }));
      out[c.name] = { limit: c.limit, elements: worst.size, worst: list };
    }
    return out;
  },
});

export const runAnalysis = defineTool<Record<string, never>>({
  name: 'run_analysis',
  description:
    'Run the hydraulic (and water-quality, if the model has one) simulation of the model as it is now, with ' +
    'the OWA-EPANET-identical engine. Changes nothing in the model. Returns a summary; use the other tools ' +
    'to look at the results.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  scope: 'analyse',
  run: async (_args, ctx) => {
    const view = await ctx.analyse();
    const r = view.results;
    const doc = ctx.doc;
    const pressures: number[] = [];
    for (let p = 0; p < r.times.length; p++) {
      const f = nodeFrame(r, 'pressure', p);
      view.nodes.forEach((h, i) => {
        if (doc.has(h) && doc.nodeKind(h) === 'junction') pressures.push(f[i]!);
      });
    }
    return {
      periods: r.times.length,
      lastHours: hours(r, r.times.length - 1),
      warning: WARNINGS[r.warning] ?? null,
      junctionPressure: stats(pressures),
    };
  },
});

export const getStatusReport = defineTool<{ max_chars?: number }>({
  name: 'get_status_report',
  description:
    "EPANET's hydraulic status log for the model as it is now: when tanks fill and empty, pumps and valves " +
    'change state, controls act, and warnings occur. Useful to explain warnings and control behaviour.',
  input: {
    type: 'object',
    properties: {
      max_chars: { type: 'integer', minimum: 500, maximum: 20000, description: 'Default 6000.' },
    },
    additionalProperties: false,
  },
  scope: 'analyse',
  run: async (args, ctx) => {
    const { report } = await ctx.files(true);
    const lines = report.split('\n');
    const start = lines.findIndex((l) => l.trim().startsWith('Hydraulic Status:'));
    const end = lines.findIndex((l, i) => i > start && l.trim().startsWith('Analysis ended'));
    const text = lines
      .slice(Math.max(0, start), end < 0 ? undefined : end)
      .map((l) => l.replace(/^ {2}/, '').trimEnd())
      .filter((l) => l.trim() !== '')
      .join('\n');
    const max = args.max_chars ?? 6000;
    return text.length > max
      ? { log: `${text.slice(0, max)}\n…`, truncated: true }
      : { log: text, truncated: false };
  },
});

export const READ_TOOLS: Tool<never>[] = [
  getProjectSummary,
  queryElements,
  getElement,
  getResultsSlice,
  getTimeseries,
  findViolations,
  runAnalysis,
  getStatusReport,
];

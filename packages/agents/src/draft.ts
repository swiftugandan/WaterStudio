/**
 * Draft tools: an agent edits its own copy of the model (a sandbox), runs analyses on
 * it, and submits what it changed as a proposal for a person to review. Nothing here
 * touches the live model; accepting a proposal is the person's act (see proposal.ts).
 */

import {
  EditError,
  addLink,
  addNode,
  deleteElements,
  fieldsOf,
  LINK_KINDS,
  NODE_KINDS,
  setField,
  type Document,
  type FieldSpec,
  type LinkKind,
  type NodeKind,
  type Store,
  type UnitSystem,
} from '@waterstudio/core';
import type { EpanetFiles, RunResults } from '@waterstudio/engine-client';
import { defineTool, type AgentContext, type RunView, type Tool } from './registry.ts';
import { kpis, Sandbox, type ChangeItem, type Evidence, type Kpis, type ProposalDraft } from './proposal.ts';

/** What a session that may propose needs from its host (the app, or the MCP server). */
export interface AgentHost {
  units: UnitSystem;
  fileName: string;
  /** The live model, which drafts are forked from. */
  doc(): Document;
  period(): number;
  /**
   * Solve a document. A draft passes its store too, so a host can keep the model in its
   * engines between runs and send only the edits (ADR 0020).
   */
  run(doc: Document, store?: Store): Promise<RunResults>;
  files(doc: Document, statusLog: boolean): Promise<EpanetFiles>;
  /** Queue a proposal for review; returns its ID. */
  submit(p: ProposalDraft): string;
  /** Who is proposing, for the record (the session's name). */
  author: string;
}

/** The agent's view in a session that may propose: the draft, its results and the queue. */
export interface DraftContext extends AgentContext {
  sandbox(): Sandbox;
  /** Start again from the live model. */
  reset(): void;
  host: AgentHost;
}

export function isDraftContext(ctx: AgentContext): ctx is DraftContext {
  return typeof (ctx as Partial<DraftContext>).sandbox === 'function';
}

function draftOf(ctx: AgentContext): DraftContext {
  if (!isDraftContext(ctx)) throw new Error('This session cannot edit: proposals are switched off.');
  return ctx;
}

/** An agent context whose model is a draft forked from the host's live model. */
export function draftContext(host: AgentHost): DraftContext {
  let sandbox = new Sandbox(host.doc());
  let cached: { rev: number; view: RunView } | null = null;
  const viewOf = (doc: Document, results: RunResults): RunView => ({
    results,
    nodes: Uint32Array.from(doc.nodeHandles()),
    links: Uint32Array.from(doc.linkHandles()),
    stale: false,
  });
  return {
    host,
    get doc() {
      return sandbox.draft;
    },
    get units() {
      return host.units;
    },
    get fileName() {
      return host.fileName;
    },
    sandbox: () => sandbox,
    reset: () => {
      sandbox = new Sandbox(host.doc());
      cached = null;
    },
    results: () => {
      if (!cached) return null;
      return { ...cached.view, stale: cached.rev !== sandbox.store.rev };
    },
    period: () => host.period(),
    analyse: async () => {
      const doc = sandbox.draft;
      const rev = sandbox.store.rev;
      const view = viewOf(doc, await host.run(doc, sandbox.store));
      cached = { rev, view };
      return view;
    },
    files: (statusLog) => host.files(sandbox.draft, statusLog),
  };
}

// ---- Values ------------------------------------------------------------------------

const isNodeKind = (k: string): k is NodeKind => (NODE_KINDS as readonly string[]).includes(k);
const isLinkKind = (k: string): k is LinkKind => (LINK_KINDS as readonly string[]).includes(k);

/** A value as the model stores it, from the readable form tools use. */
function toStored(doc: Document, spec: FieldSpec, value: unknown): unknown {
  const e = spec.editor;
  switch (e.type) {
    case 'number':
      if (value === null && e.optional) return NaN;
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new EditError(`${spec.name} must be a number.`);
      return value;
    case 'text':
      if (value === null) return null;
      if (typeof value !== 'string') throw new EditError(`${spec.name} must be text.`);
      return value;
    case 'enum': {
      const i = typeof value === 'string' ? e.options.indexOf(value) : -1;
      if (i < 0) throw new EditError(`${spec.name} must be one of ${e.options.join(', ')}.`);
      return i;
    }
    case 'pattern':
    case 'curve': {
      if (value === null || value === '') return null;
      if (typeof value !== 'string') throw new EditError(`${spec.name} must be an ID or null.`);
      const list = e.type === 'pattern' ? doc.data.patterns : doc.data.curves;
      if (!list.some((x) => x.id === value)) throw new EditError(`There is no ${e.type} called ${value}.`);
      return value;
    }
    case 'node': {
      const h = typeof value === 'string' ? doc.findNode(value) : undefined;
      if (h === undefined) throw new EditError(`There is no node called ${String(value)}.`);
      return h;
    }
    case 'none':
      throw new EditError(`${spec.name} cannot be set here.`);
  }
}

/** Fields an agent may set on an element, by lower-case name. */
function settable(kind: string): Map<string, FieldSpec> {
  return new Map(
    fieldsOf(kind as NodeKind)
      .filter((s) => s.name !== 'kind' && s.editor.type !== 'none')
      .map((s) => [s.name.toLowerCase(), s]),
  );
}

/** Set readable values on one element of the draft. `demand` sets the first category's base demand. */
function setValues(ctx: DraftContext, h: number, values: Record<string, unknown>): void {
  const store = ctx.sandbox().store;
  const doc = store.doc;
  const specs = settable(doc.kind(h));
  for (const [name, value] of Object.entries(values)) {
    if (name.toLowerCase() === 'demand' && doc.nodeKind(h) === 'junction') {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new EditError('demand must be a number.');
      const demands = structuredClone(doc.get(h, 'demands') as { base: number }[]);
      if (demands.length === 0) demands.push({ base: 0, pattern: null, category: null } as never);
      demands[0]!.base = value;
      store.transact(`Set demand of ${doc.id(h)}`, (tx) => tx.set(h, 'demands', demands));
      continue;
    }
    const spec = specs.get(name.toLowerCase());
    if (!spec) throw new EditError(`A ${doc.kind(h)} has no field ${name} that can be set.`);
    setField(store, [h], spec.name, toStored(doc, spec, value));
  }
}

const valuesSchema = {
  type: 'object',
  properties: {},
  description:
    'Field values by name, in the model units: numbers, enum names (e.g. pipeStatus "closed"), pattern and ' +
    'curve IDs (or null), node IDs. For junctions, `demand` sets the base demand of the first category.',
} as const;

function lengthOf(doc: Document, from: number, to: number, vertices: number[]): number {
  const pts = [doc.num(from, 'x'), doc.num(from, 'y'), ...vertices, doc.num(to, 'x'), doc.num(to, 'y')];
  let len = 0;
  for (let i = 2; i < pts.length; i += 2) len += Math.hypot(pts[i]! - pts[i - 2]!, pts[i + 1]! - pts[i - 1]!);
  return len;
}

// ---- Tools ---------------------------------------------------------------------------

export const setProperties = defineTool<{
  nodes?: string[];
  links?: string[];
  values: Record<string, unknown>;
}>({
  name: 'set_properties',
  description:
    'In your draft, set field values on nodes and links given by ID (all get the same values). Fields are ' +
    'those get_element shows. Changes stay in the draft until you submit a proposal.',
  input: {
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { type: 'string' }, maxItems: 5000 },
      links: { type: 'array', items: { type: 'string' }, maxItems: 5000 },
      values: valuesSchema,
    },
    required: ['values'],
    additionalProperties: false,
  },
  scope: 'draft',
  run: (args, ctx) => {
    const d = draftOf(ctx);
    const doc = d.doc;
    const targets: number[] = [];
    for (const id of args.nodes ?? []) {
      const h = doc.findNode(id);
      if (h === undefined) throw new Error(`There is no node called ${id}.`);
      targets.push(h);
    }
    for (const id of args.links ?? []) {
      const h = doc.findLink(id);
      if (h === undefined) throw new Error(`There is no link called ${id}.`);
      targets.push(h);
    }
    if (targets.length === 0) throw new Error('Name at least one node or link.');
    for (const h of targets) setValues(d, h, args.values);
    return { changed: targets.length, draftChanges: d.sandbox().changes().length };
  },
});

export const addNodes = defineTool<{
  nodes: { id?: string; kind: string; x: number; y: number; values?: Record<string, unknown> }[];
}>({
  name: 'add_nodes',
  description:
    'In your draft, add junctions, reservoirs or tanks at map coordinates (the model coordinate system; see ' +
    'get_element of nearby nodes). IDs are generated when not given. Returns the new IDs.',
  input: {
    type: 'object',
    properties: {
      nodes: {
        type: 'array',
        minItems: 1,
        maxItems: 2000,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 31 },
            kind: { type: 'string', enum: NODE_KINDS },
            x: { type: 'number' },
            y: { type: 'number' },
            values: valuesSchema,
          },
          required: ['kind', 'x', 'y'],
          additionalProperties: false,
        },
      },
    },
    required: ['nodes'],
    additionalProperties: false,
  },
  scope: 'draft',
  run: (args, ctx) => {
    const d = draftOf(ctx);
    const ids: string[] = [];
    for (const n of args.nodes) {
      if (!isNodeKind(n.kind)) throw new Error(`Unknown node kind ${n.kind}.`);
      const h = addNode(d.sandbox().store, n.kind, { x: n.x, y: n.y, ...(n.id ? { id: n.id } : {}) });
      if (n.values) setValues(d, h, n.values);
      ids.push(d.doc.id(h));
    }
    return { added: ids };
  },
});

export const addLinks = defineTool<{
  links: {
    id?: string;
    kind: string;
    from: string;
    to: string;
    vertices?: number[][];
    values?: Record<string, unknown>;
  }[];
}>({
  name: 'add_links',
  description:
    'In your draft, add pipes, pumps or valves between existing nodes (add the nodes first). A pipe without a ' +
    'length gets its length along the map (end nodes and vertices). IDs are generated when not given.',
  input: {
    type: 'object',
    properties: {
      links: {
        type: 'array',
        minItems: 1,
        maxItems: 2000,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', maxLength: 31 },
            kind: { type: 'string', enum: LINK_KINDS },
            from: { type: 'string' },
            to: { type: 'string' },
            vertices: {
              type: 'array',
              items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
              maxItems: 1000,
              description: 'Interior points [[x, y], ...].',
            },
            values: valuesSchema,
          },
          required: ['kind', 'from', 'to'],
          additionalProperties: false,
        },
      },
    },
    required: ['links'],
    additionalProperties: false,
  },
  scope: 'draft',
  run: (args, ctx) => {
    const d = draftOf(ctx);
    const ids: string[] = [];
    for (const l of args.links) {
      if (!isLinkKind(l.kind)) throw new Error(`Unknown link kind ${l.kind}.`);
      const doc = d.doc;
      const from = doc.findNode(l.from);
      const to = doc.findNode(l.to);
      if (from === undefined) throw new Error(`There is no node called ${l.from}.`);
      if (to === undefined) throw new Error(`There is no node called ${l.to}.`);
      const vertices = (l.vertices ?? []).flat();
      const h = addLink(d.sandbox().store, l.kind, { from, to, vertices, ...(l.id ? { id: l.id } : {}) });
      const values = { ...l.values };
      if (l.kind === 'pipe' && !Object.keys(values).some((k) => k.toLowerCase() === 'length')) {
        values['length'] = Number(lengthOf(doc, from, to, vertices).toFixed(2));
      }
      setValues(d, h, values);
      ids.push(doc.id(h));
    }
    return { added: ids };
  },
});

export const deleteElementsTool = defineTool<{ nodes?: string[]; links?: string[] }>({
  name: 'delete_elements',
  description:
    'In your draft, delete nodes and links by ID. Deleting a node deletes the links attached to it. ' +
    'Deletions always need a person to accept them.',
  input: {
    type: 'object',
    properties: {
      nodes: { type: 'array', items: { type: 'string' }, maxItems: 5000 },
      links: { type: 'array', items: { type: 'string' }, maxItems: 5000 },
    },
    additionalProperties: false,
  },
  scope: 'draft',
  run: (args, ctx) => {
    const d = draftOf(ctx);
    const doc = d.doc;
    const handles: number[] = [];
    for (const id of args.nodes ?? []) {
      const h = doc.findNode(id);
      if (h === undefined) throw new Error(`There is no node called ${id}.`);
      handles.push(h);
    }
    for (const id of args.links ?? []) {
      const h = doc.findLink(id);
      if (h === undefined) throw new Error(`There is no link called ${id}.`);
      handles.push(h);
    }
    return { deleted: deleteElements(d.sandbox().store, handles) };
  },
});

/** A readable summary of a changeset, for the model. */
export function describeChanges(items: readonly ChangeItem[], limit = 200): unknown {
  const shown = items.slice(0, limit).map((it) => {
    switch (it.op) {
      case 'add':
        return { add: it.kind, id: it.id };
      case 'delete':
        return { delete: it.kind, id: it.id };
      case 'set':
        return { set: it.field, of: it.id, from: it.from, to: it.to };
      case 'doc':
        return { replace: it.key };
    }
  });
  return { changes: items.length, items: shown, truncated: items.length > limit };
}

export const getDraftChanges = defineTool<Record<string, never>>({
  name: 'get_draft_changes',
  description: 'What your draft changes so far, compared with the model it was forked from.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  scope: 'draft',
  run: (_args, ctx) => describeChanges(draftOf(ctx).sandbox().changes()),
});

export const discardDraft = defineTool<Record<string, never>>({
  name: 'discard_draft',
  description: 'Throw your draft away and start again from the current model.',
  input: { type: 'object', properties: {}, additionalProperties: false },
  scope: 'draft',
  run: (_args, ctx) => {
    draftOf(ctx).reset();
    return { discarded: true };
  },
});

async function evidence(d: DraftContext): Promise<Evidence> {
  const errors: string[] = [];
  const measure = async (doc: Document): Promise<Kpis | null> => {
    try {
      const r = await d.host.run(doc);
      return kpis(doc, r, Uint32Array.from(doc.nodeHandles()), Uint32Array.from(doc.linkHandles()));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      return null;
    }
  };
  const sb = d.sandbox();
  return { before: await measure(sb.base), after: await measure(sb.draft), errors };
}

export const submitProposal = defineTool<{ title: string; rationale: string }>({
  name: 'submit_proposal',
  description:
    'Submit everything your draft changes as a proposal for the engineer to review. The engine runs the model ' +
    'before and after the change and attaches the results as evidence. Explain what you changed, why, and ' +
    'any design limit that is still not met. Afterwards your draft starts again from the current model.',
  input: {
    type: 'object',
    properties: {
      title: { type: 'string', maxLength: 120, description: 'A short name for the change.' },
      rationale: { type: 'string', maxLength: 4000 },
    },
    required: ['title', 'rationale'],
    additionalProperties: false,
  },
  scope: 'propose',
  run: async (args, ctx) => {
    const d = draftOf(ctx);
    const items = d.sandbox().changes();
    if (items.length === 0) throw new Error('Your draft changes nothing; edit it before submitting.');
    const ev = await evidence(d);
    const id = d.host.submit({
      title: args.title,
      rationale: args.rationale,
      author: d.host.author,
      items,
      evidence: ev,
    });
    d.reset();
    return { proposal: id, changes: items.length, before: ev.before, after: ev.after, errors: ev.errors };
  },
});

export const DRAFT_TOOLS: Tool<never>[] = [
  setProperties,
  addNodes,
  addLinks,
  deleteElementsTool,
  getDraftChanges,
  discardDraft,
  submitProposal,
] as Tool<never>[];

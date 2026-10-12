import { loadModel, Store, toModel, unitSystem, type Document, type model } from '@waterstudio/core';
import type { RunResults } from '@waterstudio/engine-client';
import { describe, expect, it } from 'vitest';
import { draftContext, DRAFT_TOOLS, type AgentHost } from './draft.ts';
import { applyChangeset, diffDocuments, Sandbox, type ProposalDraft } from './proposal.ts';
import { ToolRegistry } from './registry.ts';
import { READ_TOOLS } from './tools.ts';

const section = (lines: string[][] = []) => ({ lines: lines.map((tokens) => ({ tokens, comment: null })) });

function network(): model.Model {
  const j = (id: string, x: number, elevation: number): model.Node => ({
    id,
    kind: {
      type: 'junction',
      elevation,
      demands: [{ base: 1, pattern: null, category: null }],
      emitter: null,
    },
    comment: null,
    tag: null,
    coordinates: [x, 0],
    initialQuality: null,
    source: null,
  });
  const pipe = (id: string, from: string, to: string, diameter: number): model.Link => ({
    id,
    from,
    to,
    kind: {
      type: 'pipe',
      length: 100,
      diameter,
      roughness: 100,
      minorLoss: 0,
      status: 'open',
      leakage: null,
      bulkCoeff: null,
      wallCoeff: null,
    },
    comment: null,
    tag: null,
    vertices: [],
  });
  return {
    title: ['Test'],
    nodes: [
      {
        id: 'R',
        kind: { type: 'reservoir', head: 100, pattern: null, level: 0 },
        comment: null,
        tag: null,
        coordinates: [0, 0],
        initialQuality: null,
        source: null,
      },
      j('A', 100, 10),
      j('B', 200, 20),
      j('C', 300, 30),
    ],
    links: [pipe('P1', 'R', 'A', 12), pipe('P2', 'A', 'B', 8), pipe('P3', 'B', 'C', 6)],
    patterns: [{ id: 'PAT', multipliers: [1, 1.2], comment: null }],
    curves: [],
    controls: [],
    rules: [],
    options: section([['Units', 'GPM']]),
    times: section([['Duration', '1:00']]),
    report: section(),
    energy: section(),
    reactions: section(),
    backdrop: section(),
    labels: [],
    extraSections: [],
  };
}

function store(): Store {
  const s = new Store();
  loadModel(s, network());
  return s;
}

/** Results of a stand-in engine: pressure falls with elevation, velocity with diameter. */
function fakeRun(doc: Document): RunResults {
  const nodes = [...doc.nodeHandles()];
  const links = [...doc.linkHandles()];
  const col = (xs: number[]) => Float32Array.from(xs);
  return {
    engine: 'test',
    reportStart: 0,
    reportStep: 3600,
    times: [0],
    nodeCount: nodes.length,
    linkCount: links.length,
    warning: 0,
    node: {
      demand: col(nodes.map(() => 1)),
      head: col(nodes.map(() => 100)),
      pressure: col(nodes.map((h) => (doc.nodeKind(h) === 'junction' ? 40 - doc.num(h, 'elevation') : 0))),
      quality: col(nodes.map(() => 0)),
    },
    link: {
      flow: col(links.map(() => 1)),
      velocity: col(links.map((h) => 10 / doc.num(h, 'diameter'))),
      headloss: col(links.map(() => 1)),
      status: col(links.map(() => 3)),
    },
  } as unknown as RunResults;
}

function host(s: Store, queue: ProposalDraft[]): AgentHost {
  return {
    units: unitSystem(s.doc.data.options),
    fileName: 'test.inp',
    author: 'test agent',
    doc: () => s.doc,
    period: () => 0,
    run: (doc) => Promise.resolve(fakeRun(doc)),
    files: () => Promise.resolve({ report: '', out: new Uint8Array() }),
    submit: (p) => {
      queue.push(p);
      return `P${queue.length}`;
    },
  };
}

describe('changesets', () => {
  it('turn the live model into the draft, as one undoable step', () => {
    const live = store();
    const before = JSON.stringify(toModel(live.doc));
    const sb = new Sandbox(live.doc);
    const d = sb.store;
    const doc = sb.draft;
    d.transact('edit', (tx) => {
      tx.set(doc.findLink('P2')!, 'diameter', 10);
      const n = tx.addNode('junction', { id: 'D', x: 400, y: 0, elevation: 5, demands: [] });
      tx.addLink('pipe', {
        id: 'P4',
        from: doc.findNode('C')!,
        to: n,
        length: 50,
        diameter: 6,
        vertices: [],
      });
      tx.delete(doc.findLink('P1')!);
      tx.set(doc.findNode('B')!, 'id', 'B2');
      tx.setDoc('patterns', [{ id: 'PAT', multipliers: [1, 1.5], comment: null }]);
    });
    const items = sb.changes();
    expect(items.map((i) => i.op)).toEqual(['add', 'add', 'set', 'set', 'delete', 'doc']);
    expect(items[3]).toMatchObject({ op: 'set', field: 'id', id: 'B', to: 'B2' });

    const r = applyChangeset(live, items, 'Proposal: test');
    expect(r.conflicts).toEqual([]);
    expect(r.applied).toBe(6);
    expect(toModel(live.doc)).toEqual(toModel(doc));
    expect(live.undoLabel).toBe('Proposal: test');
    live.undo();
    expect(JSON.stringify(toModel(live.doc))).toBe(before);
  });

  it('skip items whose element changed since the fork, and apply only the chosen ones', () => {
    const live = store();
    const sb = new Sandbox(live.doc);
    const doc = sb.draft;
    sb.store.transact('edit', (tx) => {
      tx.set(doc.findLink('P2')!, 'diameter', 10);
      tx.set(doc.findLink('P3')!, 'diameter', 10);
      tx.set(doc.findNode('C')!, 'elevation', 31);
    });
    live.transact('meanwhile', (tx) => tx.set(live.doc.findLink('P2')!, 'diameter', 9));
    const items = sb.changes();
    const r = applyChangeset(live, items, 'Proposal', (i) => items[i]!.op !== 'set' || items[i]!.id !== 'C');
    expect(r.applied).toBe(1);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0]!.reason).toMatch(/diameter of P2 has changed/);
    expect(live.doc.num(live.doc.findLink('P2')!, 'diameter')).toBe(9);
    expect(live.doc.num(live.doc.findLink('P3')!, 'diameter')).toBe(10);
    expect(live.doc.num(live.doc.findNode('C')!, 'elevation')).toBe(30);
  });

  it('find nothing to change in an untouched draft', () => {
    const live = store();
    expect(diffDocuments(live.doc.clone(), live.doc.clone())).toEqual([]);
  });
});

describe('draft tools', () => {
  const registry = new ToolRegistry([...READ_TOOLS, ...DRAFT_TOOLS]);
  const all = ['read', 'analyse', 'draft', 'propose'] as const;

  it('edit only the draft, then submit it with evidence', async () => {
    const live = store();
    const queue: ProposalDraft[] = [];
    const ctx = draftContext(host(live, queue));
    expect(
      await registry.call('set_properties', { links: ['P3'], values: { diameter: 12 } }, ctx),
    ).toMatchObject({
      ok: false,
      error: 'set_properties is not allowed in this session.',
    });
    let r = await registry.call(
      'set_properties',
      { links: ['P3'], values: { diameter: 12, pipeStatus: 'closed' } },
      ctx,
      all,
    );
    expect(r.ok).toBe(true);
    r = await registry.call(
      'add_nodes',
      { nodes: [{ id: 'D', kind: 'junction', x: 300, y: 400, values: { elevation: 5, demand: 2.5 } }] },
      ctx,
      all,
    );
    expect(r).toEqual({ ok: true, value: { added: ['D'] } });
    r = await registry.call(
      'add_links',
      { links: [{ kind: 'pipe', from: 'C', to: 'D', values: { diameter: 6 } }] },
      ctx,
      all,
    );
    expect(r.ok).toBe(true);
    const pipe = ctx.doc.findLink(String((r as { value: { added: string[] } }).value.added[0]))!;
    expect(ctx.doc.num(pipe, 'length')).toBe(400);
    // The live model is untouched.
    expect(live.doc.num(live.doc.findLink('P3')!, 'diameter')).toBe(6);
    expect(live.doc.findNode('D')).toBeUndefined();

    r = await registry.call('set_properties', { links: ['P3'], values: { pipeStatus: 'shut' } }, ctx, all);
    expect(r).toMatchObject({ ok: false, error: 'pipeStatus must be one of open, closed, checkValve.' });

    r = await registry.call('get_draft_changes', {}, ctx, all);
    expect(r).toMatchObject({ ok: true, value: { changes: 4 } });

    r = await registry.call('submit_proposal', { title: 'Extend to D', rationale: 'Serve D.' }, ctx, all);
    expect(r).toMatchObject({ ok: true, value: { proposal: 'P1', changes: 4 } });
    expect(queue).toHaveLength(1);
    const p = queue[0]!;
    expect(p.author).toBe('test agent');
    expect(p.evidence.before).toMatchObject({ minPressure: 10, maxVelocity: 1.667 });
    expect(p.evidence.after!.minPressure).toBe(10);
    // The draft starts again from the live model.
    expect(ctx.doc.findNode('D')).toBeUndefined();
    r = await registry.call('submit_proposal', { title: 'Nothing', rationale: '' }, ctx, all);
    expect(r).toMatchObject({ ok: false, error: 'Your draft changes nothing; edit it before submitting.' });

    applyChangeset(live, p.items, 'Proposal: Extend to D');
    expect(live.doc.findNode('D')).toBeDefined();
    expect(live.doc.num(live.doc.findLink('P3')!, 'pipeStatus')).toBe(1);
  });

  it('run analyses on the draft and mark them stale after an edit', async () => {
    const live = store();
    const ctx = draftContext(host(live, []));
    expect(ctx.results()).toBeNull();
    await registry.call('run_analysis', {}, ctx, all);
    expect(ctx.results()!.stale).toBe(false);
    await registry.call('delete_elements', { nodes: ['C'] }, ctx, all);
    expect(ctx.results()!.stale).toBe(true);
    expect(ctx.doc.findLink('P3')).toBeUndefined();
    expect(live.doc.findLink('P3')).toBeDefined();
  });
});

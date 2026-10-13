import { describe, expect, it } from 'vitest';
import { loadModel, toModel } from './convert.ts';
import { addLink, addNode, deleteElements, setField } from './edits.ts';
import type { Link, Model, ModelPatch, Node, Snapshot } from './generated/model.ts';
import { Store } from './store.ts';
import { EngineSync } from './sync.ts';

/** What the engine's mirror (ws_model::Mirror) does with a snapshot and patches. */
class Mirror {
  nodes: (Node | null)[] = [];
  links: (Link | null)[] = [];
  rest: Model;
  rev: number;

  constructor(s: Snapshot) {
    s.nodeSlots.forEach((slot, i) => (this.nodes[slot] = s.model.nodes[i]!));
    s.linkSlots.forEach((slot, i) => (this.links[slot] = s.model.links[i]!));
    this.rest = structuredClone(s.model);
    this.rev = s.rev;
  }

  apply(p: ModelPatch): void {
    expect(p.from).toBe(this.rev);
    for (const s of p.nodes) this.nodes[s.slot] = s.node;
    for (const s of p.links) this.links[s.slot] = s.link;
    for (const k of Object.keys(p)) {
      if (!['epoch', 'from', 'to', 'nodes', 'links'].includes(k))
        (this.rest as unknown as Record<string, unknown>)[k] = (p as unknown as Record<string, unknown>)[k];
    }
    this.rev = p.to;
  }

  model(): Model {
    return {
      ...this.rest,
      nodes: this.nodes.filter((n): n is Node => !!n),
      links: this.links.filter((l): l is Link => !!l),
    };
  }
}

const junction = (id: string, elevation: number): Node => ({
  id,
  kind: { type: 'junction', elevation, demands: [{ base: 1, pattern: null, category: null }], emitter: null },
  comment: null,
  tag: null,
  coordinates: [elevation, 0],
  initialQuality: null,
  source: null,
});

const MODEL: Model = {
  title: ['Sync'],
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
    junction('A', 10),
    junction('B', 20),
  ],
  links: ['R-A', 'A-B'].map((id) => {
    const [from, to] = id.split('-') as [string, string];
    return {
      id: `P${id}`,
      from,
      to,
      kind: {
        type: 'pipe',
        length: 100,
        diameter: 12,
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
    };
  }),
  patterns: [],
  curves: [],
  controls: [],
  rules: [],
  options: { lines: [] },
  times: { lines: [] },
  report: { lines: [] },
  energy: { lines: [] },
  reactions: { lines: [] },
  backdrop: { lines: [] },
  labels: [],
  extraSections: [],
};

function fresh(): { store: Store; sync: EngineSync } {
  const store = new Store();
  loadModel(store, MODEL);
  return { store, sync: new EngineSync(store) };
}

describe('EngineSync', () => {
  it('opens an engine with the whole model and its slots', () => {
    const { store, sync } = fresh();
    const s = sync.snapshot();
    expect(s.model).toEqual(toModel(store.doc));
    expect(s.nodeSlots).toEqual([0, 1, 2]);
    expect(s.rev).toBe(store.rev);
    expect(new Mirror(s).model()).toEqual(toModel(store.doc));
  });

  it('sends only what changed, and patches from any revision reproduce the document', () => {
    const { store, sync } = fresh();
    const doc = store.doc;
    const mirrors = [new Mirror(sync.snapshot())];
    const h = (id: string) => doc.findNode(id) ?? doc.findLink(id)!;
    const steps: (() => void)[] = [
      () => setField(store, [h('A')], 'elevation', 12),
      () => setField(store, [h('PA-B')], 'diameter', 8),
      () => addNode(store, 'junction', { id: 'C', x: 3, y: 0 }),
      () => addLink(store, 'pipe', { id: 'PB-C', from: h('B'), to: h('C') }),
      () => setField(store, [h('B')], 'id', 'B2'), // its links name it
      () => deleteElements(store, [h('A')]), // and its two pipes
      () => store.undo(),
      () => store.undo(),
      () => store.redo(),
      () => store.transact('Title', (tx) => tx.setDoc('title', ['Edited'])),
      () =>
        store.transact('Pattern', (tx) =>
          tx.setDoc('patterns', [{ id: 'P1', comment: null, multipliers: [1, 2] }]),
        ),
      () => store.transact('MSX', (tx) => tx.setDoc('msx', { name: 'x.msx', text: '' })), // not in the model
    ];
    for (const step of steps) {
      step();
      // A mirror opened at every earlier revision catches up with one patch.
      for (const m of mirrors) {
        const p = sync.patch(m.rev)!;
        m.apply(p);
        expect(m.model()).toEqual(toModel(doc));
      }
      mirrors.push(new Mirror(sync.snapshot()));
    }
    // An unrelated edit sends one slot.
    const before = store.rev;
    setField(store, [h('C')], 'elevation', 5);
    const p = sync.patch(before)!;
    expect(p.nodes).toHaveLength(1);
    expect(p.links).toHaveLength(0);
    expect(Object.keys(p).sort()).toEqual(['epoch', 'from', 'links', 'nodes', 'to']);
  });

  it('refuses to patch from before its log or from another epoch', () => {
    const { store, sync } = fresh();
    const other = new EngineSync(store);
    expect(other.epoch).not.toBe(sync.epoch);
    const small = new EngineSync(store, { limit: 2 });
    const start = store.rev;
    for (let i = 0; i < 4; i++) setField(store, [store.doc.findNode('A')!], 'elevation', i);
    expect(small.patch(start)).toBeNull();
    expect(small.patch(store.rev - 2)).not.toBeNull();
    expect(sync.patch(store.rev + 1)).toBeNull();
    expect(sync.patch(store.rev)).toMatchObject({ nodes: [], links: [] });
  });
});

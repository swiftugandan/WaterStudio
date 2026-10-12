import { loadModel, Store, type model } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { emptyModel } from './state.ts';
import {
  allocatePoints,
  allocateTotal,
  applyAllocation,
  junctions,
  parseDemandPoints,
  withDemand,
} from './demands.ts';

/** A — 100 — B — 300 — C, all junctions on the x axis. */
function net(): Store {
  const j = (id: string, x: number): model.Node => ({
    id,
    kind: {
      type: 'junction',
      elevation: 0,
      demands: [{ base: 1, pattern: null, category: null }],
      emitter: null,
    },
    coordinates: [x, 0],
    tag: null,
    initialQuality: null,
    source: null,
    comment: null,
  });
  const pipe = (id: string, from: string, to: string, length: number): model.Link => ({
    id,
    from,
    to,
    kind: {
      type: 'pipe',
      length,
      diameter: 12,
      roughness: 100,
      minorLoss: 0,
      status: 'open',
      leakage: null,
      bulkCoeff: null,
      wallCoeff: null,
    },
    vertices: [],
    tag: null,
    comment: null,
  });
  const store = new Store();
  loadModel(store, {
    ...emptyModel(),
    nodes: [j('A', 0), j('B', 100), j('C', 400)],
    links: [pipe('1', 'A', 'B', 100), pipe('2', 'B', 'C', 300)],
  });
  return store;
}

describe('demand allocation', () => {
  it('spreads a total equally or by the length of pipe each junction serves', () => {
    const s = net();
    const doc = s.doc;
    const t = junctions(doc);
    const eq = allocateTotal(doc, t, 30, 'equal');
    expect([...eq.demands.values()]).toEqual([10, 10, 10]);
    const byLen = allocateTotal(doc, t, 40, 'length');
    // Half lengths: A 50, B 200, C 150.
    expect([...byLen.demands.values()]).toEqual([5, 20, 15]);
  });

  it('assigns points to the nearest junction or splits them along the nearest pipe', () => {
    const s = net();
    const doc = s.doc;
    const t = junctions(doc);
    const pts = [
      { x: 10, y: 5, demand: 2 },
      { x: 390, y: -3, demand: 4 },
      { x: 230, y: 20, demand: 6 },
    ];
    const near = allocatePoints(doc, t, pts, 'node');
    const id = (m: Map<number, number>) => Object.fromEntries([...m].map(([h, q]) => [doc.id(h), q]));
    expect(id(near.demands)).toEqual({ A: 2, C: 4, B: 6 });
    const along = allocatePoints(doc, t, pts, 'pipe');
    const got = id(along.demands);
    // 230 is 130 of 300 along pipe 2 (100 → 400): 3.4 to B and 2.6 to C.
    expect(got['A']).toBeCloseTo(2 * 0.9);
    expect(got['B']).toBeCloseTo(2 * 0.1 + 4 * (10 / 300) + 3.4);
    expect(got['C']).toBeCloseTo(4 * (290 / 300) + 2.6);
    const far = allocatePoints(doc, t, [{ x: 0, y: 1000, demand: 1 }], 'node', 50);
    expect(far.unassigned).toBe(1);
  });

  it('writes into a named category or the first one, adding or replacing', () => {
    const first = [{ base: 1, pattern: 'P', category: null }];
    expect(withDemand(first, 5, { category: '', pattern: null, add: false })).toEqual([
      { base: 5, pattern: 'P', category: null },
    ]);
    expect(withDemand(first, 5, { category: '', pattern: null, add: true })[0]!.base).toBe(6);
    expect(withDemand(first, 2, { category: 'Leaks', pattern: 'L', add: false })).toEqual([
      ...first,
      { base: 2, pattern: 'L', category: 'Leaks' },
    ]);
    const s = net();
    const n = applyAllocation(
      s,
      allocateTotal(s.doc, junctions(s.doc), 3, 'equal'),
      { category: '', pattern: null, add: true },
      'Allocate',
    );
    expect(n).toBe(3);
    expect((s.doc.get(s.doc.findNode('B')!, 'demands') as model.Demand[])[0]!.base).toBe(2);
    expect(s.undo()).toBe(true);
    expect((s.doc.get(s.doc.findNode('B')!, 'demands') as model.Demand[])[0]!.base).toBe(1);
  });

  it('reads points from CSV with any column order', () => {
    const r = parseDemandPoints('Demand,Y,X\n2,5,10\n4,-3,390\nbad,1,2\n');
    expect(r.points).toEqual([
      { x: 10, y: 5, demand: 2 },
      { x: 390, y: -3, demand: 4 },
    ]);
    expect(r.issues).toHaveLength(1);
    expect(parseDemandPoints('a,b\n1,2').issues[0]).toContain('No column named x, y, demand');
  });
});

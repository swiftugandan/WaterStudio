import { loadModel, Store, type model } from '@waterstudio/core';
import type { RunResults } from '@waterstudio/engine-client';
import { describe, expect, it } from 'vitest';
import { frequency, profilePath, profileSeries, systemFlow, timeSeries, type RunIndex } from './graphs.ts';
import { emptyModel } from './state.ts';

const junction = (id: string, elevation: number): model.Node => ({
  id,
  kind: { type: 'junction', elevation, demands: [], emitter: null },
  comment: null,
  tag: null,
  coordinates: [0, 0],
  initialQuality: null,
  source: null,
});

const pipe = (id: string, from: string, to: string, length: number): model.Link => ({
  id,
  from,
  to,
  kind: {
    type: 'pipe',
    length,
    diameter: 8,
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

// R - A - B - C, with a long shortcut A - C.
function doc() {
  const m = emptyModel();
  m.nodes = [
    {
      ...junction('R', 0),
      kind: { type: 'reservoir', head: 100, pattern: null, level: 0 },
    },
    junction('A', 10),
    junction('B', 20),
    junction('C', 30),
  ];
  m.links = [
    pipe('1', 'R', 'A', 100),
    pipe('2', 'A', 'B', 50),
    pipe('3', 'B', 'C', 50),
    pipe('4', 'A', 'C', 500),
  ];
  const store = new Store();
  loadModel(store, m);
  return store.doc;
}

function run(d: ReturnType<typeof doc>): RunIndex {
  const nodes = Uint32Array.from(d.nodeHandles());
  const links = Uint32Array.from(d.linkHandles());
  const col = (n: number, f: (p: number, i: number) => number) =>
    Float32Array.from({ length: 2 * n }, (_, k) => f(Math.floor(k / n), k % n));
  const results = {
    engine: 'test',
    reportStart: 0,
    reportStep: 3600,
    times: [0, 3600],
    nodeCount: 4,
    linkCount: 4,
    // R supplies everything; A, B, C draw 1, 2, 3 (doubled in period 1).
    node: {
      demand: col(4, (p, i) => (i === 0 ? -6 * (p + 1) : i * (p + 1))),
      head: col(4, (p, i) => 100 - i - p),
      pressure: col(4, (_, i) => 50 - i),
    },
    link: { flow: col(4, (_, i) => (i === 3 ? -1 : i + 1)) },
  } as unknown as RunResults;
  return { results, nodes, links };
}

describe('graphs', () => {
  it('follows the shortest path through the chosen nodes', () => {
    const d = doc();
    const p = profilePath(d, ['R', 'C'])!;
    expect(p.nodes.map((h) => d.id(h))).toEqual(['R', 'A', 'B', 'C']);
    expect(p.distance).toEqual([0, 100, 150, 200]);
    expect(profilePath(d, ['R'])).toBeNull();
  });

  it('plots head along the path with the ground beneath it', () => {
    const d = doc();
    const prof = profileSeries(d, run(d), { kind: 'profile', variable: 'head', ids: ['R', 'C'] }, 1)!;
    expect(Array.from(prof.series[0]!.y)).toEqual([99, 98, 97, 96]);
    expect(Array.from(prof.series[1]!.y)).toEqual([100, 10, 20, 30]);
    expect(prof.labels).toEqual(['R', 'A', 'B', 'C']);
  });

  it('makes one time series per element', () => {
    const d = doc();
    const s = timeSeries(d, run(d), {
      kind: 'series',
      table: 'node',
      variable: 'demand',
      ids: ['B', 'nope'],
    });
    expect(s.map((x) => x.name)).toEqual(['Junction B']);
    expect(Array.from(s[0]!.x)).toEqual([0, 1]);
    expect(Array.from(s[0]!.y)).toEqual([2, 4]);
  });

  it('builds cumulative distributions', () => {
    const f = frequency([3, 1, 2, NaN]);
    expect(f.x).toEqual([1, 2, 3]);
    expect(f.y.map((v) => Math.round(v))).toEqual([33, 67, 100]);
    expect(frequency([-2, 1], true).x).toEqual([1, 2]);
  });

  it('balances production and consumption', () => {
    const d = doc();
    const [prod, cons] = systemFlow(d, run(d));
    expect(Array.from(prod!.y)).toEqual([6, 12]);
    expect(Array.from(cons!.y)).toEqual([6, 12]);
  });
});

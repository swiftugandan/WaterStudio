/** Synthetic networks for performance budgets: an n × n grid of junctions fed by one reservoir. */

import type { model } from '@waterstudio/core';
import { emptyModel } from './state.ts';

export function gridModel(n: number, spacing = 100): model.Model {
  const m = emptyModel();
  const id = (i: number, j: number) => `J${i}_${j}`;
  m.nodes.push({
    id: 'R',
    kind: { type: 'reservoir', head: 200, pattern: null, level: 0 },
    comment: null,
    tag: null,
    coordinates: [-spacing, 0],
    initialQuality: null,
    source: null,
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      m.nodes.push({
        id: id(i, j),
        kind: {
          type: 'junction',
          elevation: 0,
          demands: [{ base: 0.1, pattern: null, category: null }],
          emitter: null,
        },
        comment: null,
        tag: null,
        coordinates: [i * spacing, j * spacing],
        initialQuality: null,
        source: null,
      });
    }
  }
  const pipe = (pid: string, from: string, to: string): model.Link => ({
    id: pid,
    from,
    to,
    kind: {
      type: 'pipe',
      length: spacing,
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
  m.links.push(pipe('P0', 'R', id(0, 0)));
  let k = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) m.links.push(pipe(`P${k++}`, id(i, j), id(i + 1, j)));
      if (j + 1 < n) m.links.push(pipe(`P${k++}`, id(i, j), id(i, j + 1)));
    }
  }
  return m;
}

/** The grid as an extended-period model: `hours` of hourly steps under a daily demand pattern. */
export function epsModel(n: number, hours = 24): model.Model {
  const m = gridModel(n);
  const day = [0.6, 0.5, 0.5, 0.6, 0.8, 1.1, 1.4, 1.5, 1.3, 1.2, 1.1, 1.1];
  m.patterns.push({ id: 'DAY', comment: null, multipliers: [...day, ...day.slice().reverse()] });
  for (const node of m.nodes) {
    if (node.kind.type === 'junction') for (const d of node.kind.demands) d.pattern = 'DAY';
  }
  const line = (tokens: string[]) => ({ tokens, comment: null });
  m.times = {
    lines: [
      line(['Duration', `${hours}:00`]),
      line(['Hydraulic', 'Timestep', '1:00']),
      line(['Pattern', 'Timestep', '1:00']),
      line(['Report', 'Timestep', '1:00']),
    ],
  };
  return m;
}

/** A deterministic hash of three integers to [0, 1). */
function unit(i: number, j: number, k: number): number {
  let v = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791);
  v = Math.imul(v ^ (v >>> 15), 2246822519);
  v = Math.imul(v ^ (v >>> 13), 3266489917);
  return ((v ^ (v >>> 16)) >>> 0) / 2 ** 32;
}

/**
 * A synthetic network with the sparsity of real distribution systems (about 1.25 pipes
 * per junction, as utility models have; a full grid has two): n × n junctions, a 24-inch
 * trunk along the first row, 8-inch streets along the columns with a 12-inch main every
 * tenth, and a quarter of the cross streets, under `hours` of hourly demands.
 */
export function networkModel(n: number, hours = 24): model.Model {
  const m = epsModel(1, hours);
  m.nodes = [];
  m.links = [];
  const id = (i: number, j: number) => `J${i}_${j}`;
  m.nodes.push({
    id: 'R',
    kind: { type: 'reservoir', head: 250, pattern: null, level: 0 },
    comment: null,
    tag: null,
    coordinates: [-100, 0],
    initialQuality: null,
    source: null,
  });
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      m.nodes.push({
        id: id(i, j),
        kind: {
          type: 'junction',
          elevation: 0,
          demands: [{ base: 0.5, pattern: 'DAY', category: null }],
          emitter: null,
        },
        comment: null,
        tag: null,
        coordinates: [i * 100, j * 100],
        initialQuality: null,
        source: null,
      });
    }
  }
  const pipe = (pid: string, from: string, to: string, diameter: number): model.Link => ({
    id: pid,
    from,
    to,
    kind: {
      type: 'pipe',
      length: 100,
      diameter,
      roughness: 120,
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
  m.links.push(pipe('P0', 'R', id(0, 0), 24));
  let k = 1;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (j + 1 < n) m.links.push(pipe(`P${k++}`, id(i, j), id(i, j + 1), i % 10 === 0 ? 12 : 8));
      if (i + 1 < n && (j === 0 || unit(i, j, 1) < 0.25))
        m.links.push(pipe(`P${k++}`, id(i, j), id(i + 1, j), j === 0 ? 24 : 8));
    }
  }
  return m;
}

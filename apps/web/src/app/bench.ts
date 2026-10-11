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

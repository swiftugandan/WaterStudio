/** Turning engine results into colour classes for the scene, and the legend shown on the map. */

import {
  linkFrame,
  nodeFrame,
  type LinkVariable,
  type NodeVariable,
  type RunResults,
} from '@waterstudio/engine-client';
import {
  classify,
  emptyPaint,
  legendFor,
  type Legend,
  type Paint,
  type RampName,
  type Scene,
} from '@waterstudio/render';
import type { Quantity } from '@waterstudio/core';
import type { RunState } from '../app/state.ts';

export const VARIABLE_QUANTITY: Record<NodeVariable | LinkVariable, Quantity | 'headloss'> = {
  demand: 'flow',
  head: 'head',
  pressure: 'pressure',
  deficit: 'flow',
  emitter: 'flow',
  leakage: 'flow',
  flow: 'flow',
  velocity: 'velocity',
  headloss: 'headloss',
  status: 'none',
  setting: 'none',
  quality: 'concentration',
};

const legendCache = new WeakMap<RunResults, Map<string, Legend>>();

/** A legend for a variable over every period, so colours stay put during playback. */
export function legendOf(r: RunResults, table: 'node' | 'link', v: string, ramp: RampName): Legend {
  let m = legendCache.get(r);
  if (!m) {
    m = new Map();
    legendCache.set(r, m);
  }
  const key = `${table}:${v}:${ramp}`;
  let l = m.get(key);
  if (!l) {
    const col = table === 'node' ? r.node[v as NodeVariable] : r.link[v as LinkVariable];
    // Flow colours by magnitude: direction is shown by arrows, not colour.
    const values = v === 'flow' ? col.map(Math.abs) : col;
    l = legendFor(values, ramp);
    m.set(key, l);
  }
  return l;
}

const indexCache = new WeakMap<Uint32Array, Map<number, number>>();
function indexOf(handles: Uint32Array): Map<number, number> {
  let m = indexCache.get(handles);
  if (!m) {
    m = new Map();
    for (let i = 0; i < handles.length; i++) m.set(handles[i]!, i);
    indexCache.set(handles, m);
  }
  return m;
}

/** Values of a run's frame for the scene's elements, by handle (NaN where absent). */
function mapFrame(
  frame: Float32Array,
  runHandles: Uint32Array,
  sceneHandles: Uint32Array,
  abs: boolean,
): Float32Array {
  const idx = indexOf(runHandles);
  const out = new Float32Array(sceneHandles.length);
  for (let i = 0; i < sceneHandles.length; i++) {
    const k = idx.get(sceneHandles[i]!);
    const v = k === undefined ? NaN : frame[k]!;
    out[i] = abs ? Math.abs(v) : v;
  }
  return out;
}

export function computePaint(
  scene: Scene,
  run: RunState,
  period: number,
  theme: { node: NodeVariable | null; link: LinkVariable | null; ramp: RampName },
): Paint {
  const paint = emptyPaint(scene.nodeCount, scene.linkCount);
  const r = run.results;
  if (!r || !run.nodes || !run.links) return paint;
  const p = Math.min(period, r.times.length - 1);
  if (theme.node) {
    const legend = legendOf(r, 'node', theme.node, theme.ramp);
    classify(
      mapFrame(nodeFrame(r, theme.node, p), run.nodes, scene.nodeHandles, false),
      legend,
      paint.nodeClass,
    );
    paint.nodeLegend = legend;
  }
  if (theme.link) {
    const legend = legendOf(r, 'link', theme.link, theme.ramp);
    const abs = theme.link === 'flow';
    classify(
      mapFrame(linkFrame(r, theme.link, p), run.links, scene.linkHandles, abs),
      legend,
      paint.linkClass,
    );
    paint.linkLegend = legend;
  }
  return paint;
}

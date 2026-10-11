/**
 * Results of a hydraulic run as f32 columns, decoded from the engine's binary reply
 * (`ws_study::run::encode`). Column layout: `node[variable][period * nodeCount + i]`,
 * where `i` is the element's position among the model's nodes (links likewise).
 */

export const NODE_VARIABLES = ['demand', 'head', 'pressure', 'deficit', 'emitter', 'leakage'] as const;
export const LINK_VARIABLES = ['flow', 'velocity', 'headloss', 'status', 'setting', 'leakage'] as const;
export type NodeVariable = (typeof NODE_VARIABLES)[number];
export type LinkVariable = (typeof LINK_VARIABLES)[number];

export interface RunResults {
  engine: string;
  reportStart: number;
  reportStep: number;
  /** Simulation time of each period's solution, in seconds. */
  times: number[];
  nodeCount: number;
  linkCount: number;
  node: Record<NodeVariable, Float32Array>;
  link: Record<LinkVariable, Float32Array>;
}

interface Header {
  engine: string;
  reportStart: number;
  reportStep: number;
  times: number[];
  nodeCount: number;
  linkCount: number;
  nodeVariables: string[];
  linkVariables: string[];
}

/** Decode the engine's binary reply. Columns are copied out of `bytes`. */
export function decodeResults(bytes: Uint8Array): RunResults {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const hlen = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen))) as Header;
  let offset = Math.ceil((4 + hlen) / 4) * 4;
  const periods = header.times.length;
  const take = (count: number): Float32Array => {
    const n = periods * count;
    const out = new Float32Array(n);
    // The reply is little-endian; read through DataView so big-endian hosts work too.
    for (let i = 0; i < n; i++) out[i] = view.getFloat32(offset + 4 * i, true);
    offset += 4 * n;
    return out;
  };
  const node = {} as Record<NodeVariable, Float32Array>;
  for (const v of header.nodeVariables) node[v as NodeVariable] = take(header.nodeCount);
  const link = {} as Record<LinkVariable, Float32Array>;
  for (const v of header.linkVariables) link[v as LinkVariable] = take(header.linkCount);
  if (offset !== bytes.byteLength) throw new Error('engine results have an unexpected length');
  return {
    engine: header.engine,
    reportStart: header.reportStart,
    reportStep: header.reportStep,
    times: header.times,
    nodeCount: header.nodeCount,
    linkCount: header.linkCount,
    node,
    link,
  };
}

/** One period of a node variable, as a view (no copy). */
export function nodeFrame(r: RunResults, v: NodeVariable, period: number): Float32Array {
  return r.node[v].subarray(period * r.nodeCount, (period + 1) * r.nodeCount);
}

export function linkFrame(r: RunResults, v: LinkVariable, period: number): Float32Array {
  return r.link[v].subarray(period * r.linkCount, (period + 1) * r.linkCount);
}

/** Every period of one element's variable. */
export function nodeSeries(r: RunResults, v: NodeVariable, i: number): Float32Array {
  const out = new Float32Array(r.times.length);
  for (let p = 0; p < out.length; p++) out[p] = r.node[v][p * r.nodeCount + i]!;
  return out;
}

export function linkSeries(r: RunResults, v: LinkVariable, i: number): Float32Array {
  const out = new Float32Array(r.times.length);
  for (let p = 0; p < out.length; p++) out[p] = r.link[v][p * r.linkCount + i]!;
  return out;
}

/** Transferable buffers of a result, for postMessage. */
export function transferables(r: RunResults): ArrayBuffer[] {
  return [...Object.values(r.node), ...Object.values(r.link)].map((a) => a.buffer as ArrayBuffer);
}

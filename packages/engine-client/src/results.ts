/**
 * Results of a run as f32 columns, decoded from the engine's binary reply
 * (`ws_study::run::encode`). Column layout: `node[variable][period * nodeCount + i]`,
 * where `i` is the element's position among the model's nodes (links likewise).
 */

export const NODE_VARIABLES = [
  'demand',
  'head',
  'pressure',
  'quality',
  'deficit',
  'emitter',
  'leakage',
] as const;
/** `status` holds EPANET's status codes; `reaction` is the reaction rate (quality units per day). */
export const LINK_VARIABLES = [
  'flow',
  'velocity',
  'headloss',
  'quality',
  'status',
  'setting',
  'reaction',
  'friction',
  'leakage',
] as const;
export type NodeVariable = (typeof NODE_VARIABLES)[number];
export type LinkVariable = (typeof LINK_VARIABLES)[number];

/** A species of an EPANET-MSX run, as a result variable: `msx:` and the species ID. */
export type SpeciesVariable = `msx:${string}`;
/** Any node result: an EPANET variable or an MSX species. */
export type NodeVar = NodeVariable | SpeciesVariable;
/** Any link result: an EPANET variable or an MSX species. */
export type LinkVar = LinkVariable | SpeciesVariable;

export interface SpeciesInfo {
  id: string;
  /** Bulk species are carried by the flow; wall species stay on pipe walls (zero at nodes). */
  kind: 'bulk' | 'wall';
  /** Concentration units, e.g. "MG/L" or "UG/M2". */
  units: string;
  /** Reporting precision (decimal places). */
  precision: number;
}

/** What an EPANET-MSX analysis adds to a run. */
export interface MsxInfo {
  title: string;
  species: SpeciesInfo[];
  /** The report the MSX input's [REPORT] section asks for (may be empty). */
  report: string;
  /** Lines written while reading the input. */
  messages: string[];
}

export function isSpecies(v: string): v is SpeciesVariable {
  return v.startsWith('msx:');
}

export function speciesVariable(id: string): SpeciesVariable {
  return `msx:${id}`;
}

/** Node variables a run has: EPANET's, then the bulk species (wall species stay on pipe walls). */
export function nodeVariables(r?: RunResults): NodeVar[] {
  const species = (r?.msx?.species ?? []).filter((s) => s.kind === 'bulk').map((s) => speciesVariable(s.id));
  return [...NODE_VARIABLES, ...species];
}

/** Link variables a run has: EPANET's, then every species. */
export function linkVariables(r?: RunResults): LinkVar[] {
  return [...LINK_VARIABLES, ...(r?.msx?.species ?? []).map((s) => speciesVariable(s.id))];
}

/** The species a variable names, if it names one in this run. */
export function speciesOf(r: RunResults | undefined, v: string): SpeciesInfo | undefined {
  if (!r?.msx || !isSpecies(v)) return undefined;
  const id = v.slice(4);
  return r.msx.species.find((s) => s.id === id);
}

export interface RunResults {
  engine: string;
  reportStart: number;
  reportStep: number;
  /** Simulation time of each period's solution, in seconds. */
  times: number[];
  nodeCount: number;
  linkCount: number;
  /** EPANET's last hydraulic warning code (0 if none; 1 unbalanced, 2 unstable, 4 pumps, 5 valves, 6 negative pressures). */
  warning: number;
  /** Columns by variable; species columns are keyed `msx:<id>` (see {@link nodeColumn}). */
  node: Record<NodeVariable, Float32Array>;
  link: Record<LinkVariable, Float32Array>;
  /** Present when the run included an EPANET-MSX analysis. */
  msx?: MsxInfo;
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
  warning?: number;
  msx?: MsxInfo;
}

const EMPTY = new Float32Array(0);

/** The column of any node variable (empty if the run does not have it). */
export function nodeColumn(r: RunResults, v: NodeVar): Float32Array {
  return (r.node as Record<string, Float32Array | undefined>)[v] ?? EMPTY;
}

/** The column of any link variable (empty if the run does not have it). */
export function linkColumn(r: RunResults, v: LinkVar): Float32Array {
  return (r.link as Record<string, Float32Array | undefined>)[v] ?? EMPTY;
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
  for (const sp of header.msx?.species ?? []) {
    (node as Record<string, Float32Array>)[speciesVariable(sp.id)] = take(header.nodeCount);
    (link as Record<string, Float32Array>)[speciesVariable(sp.id)] = take(header.linkCount);
  }
  if (offset !== bytes.byteLength) throw new Error('engine results have an unexpected length');
  return {
    engine: header.engine,
    reportStart: header.reportStart,
    reportStep: header.reportStep,
    times: header.times,
    nodeCount: header.nodeCount,
    linkCount: header.linkCount,
    warning: header.warning ?? 0,
    node,
    link,
    ...(header.msx ? { msx: header.msx } : {}),
  };
}

/** One period of a node variable, as a view (no copy). */
export function nodeFrame(r: RunResults, v: NodeVar, period: number): Float32Array {
  return nodeColumn(r, v).subarray(period * r.nodeCount, (period + 1) * r.nodeCount);
}

export function linkFrame(r: RunResults, v: LinkVar, period: number): Float32Array {
  return linkColumn(r, v).subarray(period * r.linkCount, (period + 1) * r.linkCount);
}

/** Every period of one element's variable. */
export function nodeSeries(r: RunResults, v: NodeVar, i: number): Float32Array {
  const col = nodeColumn(r, v);
  const out = new Float32Array(r.times.length);
  for (let p = 0; p < out.length; p++) out[p] = col[p * r.nodeCount + i] ?? 0;
  return out;
}

export function linkSeries(r: RunResults, v: LinkVar, i: number): Float32Array {
  const col = linkColumn(r, v);
  const out = new Float32Array(r.times.length);
  for (let p = 0; p < out.length; p++) out[p] = col[p * r.linkCount + i] ?? 0;
  return out;
}

/** Transferable buffers of a result, for postMessage. */
export function transferables(r: RunResults): ArrayBuffer[] {
  return [...Object.values(r.node), ...Object.values(r.link)].map((a) => a.buffer as ArrayBuffer);
}

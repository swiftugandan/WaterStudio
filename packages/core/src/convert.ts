/**
 * Conversion between the document and the canonical model (`ws-model`, shared with
 * the Rust engine through generated types). `toModel(fromModel(m))` equals `m`.
 */

import type { Document, DocData } from './document.ts';
import type {
  Link as MLink,
  LinkKind as MLinkKind,
  Model,
  Node as MNode,
  NodeKind as MNodeKind,
  OpenClosed,
  PipeStatus,
  ValveType,
} from './generated/model.ts';
import { FIXED_STATUS, OPEN_CLOSED, OVERFLOW, PIPE_STATUS, PUMP_CURVE_TYPES, VALVE_TYPES } from './schema.ts';
import type { Store, Tx } from './store.ts';

const nan = (v: number | null | undefined): number => (v === null || v === undefined ? NaN : v);
const opt = (v: number): number | null => (Number.isNaN(v) ? null : v);
const idx = <T extends string>(list: readonly T[], v: T): number => Math.max(0, list.indexOf(v));

function nodeValues(n: MNode): { kind: 'junction' | 'reservoir' | 'tank'; values: Record<string, unknown> } {
  const base: Record<string, unknown> = {
    id: n.id,
    x: n.coordinates ? n.coordinates[0] : NaN,
    y: n.coordinates ? n.coordinates[1] : NaN,
    comment: n.comment,
    tag: n.tag,
    initialQuality: nan(n.initialQuality),
    source: n.source,
  };
  const k = n.kind;
  switch (k.type) {
    case 'junction':
      return {
        kind: 'junction',
        values: { ...base, elevation: k.elevation, demands: k.demands, emitter: nan(k.emitter) },
      };
    case 'reservoir':
      return {
        kind: 'reservoir',
        values: { ...base, head: k.head, headPattern: k.pattern, level: k.level },
      };
    case 'tank':
      return {
        kind: 'tank',
        values: {
          ...base,
          elevation: k.elevation,
          initLevel: k.initLevel,
          minLevel: k.minLevel,
          maxLevel: k.maxLevel,
          diameter: k.diameter,
          minVolume: k.minVolume,
          volumeCurve: k.volumeCurve,
          overflow: k.overflow === null ? 0 : k.overflow ? 2 : 1,
          mixing: k.mixing,
          bulkCoeff: nan(k.bulkCoeff),
        },
      };
  }
}

function linkValues(
  l: MLink,
  nodeHandle: (id: string) => number,
): { kind: 'pipe' | 'pump' | 'valve'; values: Record<string, unknown> } {
  const base: Record<string, unknown> = {
    id: l.id,
    from: nodeHandle(l.from),
    to: nodeHandle(l.to),
    comment: l.comment,
    tag: l.tag,
    vertices: l.vertices.flat(),
  };
  const k = l.kind;
  switch (k.type) {
    case 'pipe':
      return {
        kind: 'pipe',
        values: {
          ...base,
          length: k.length,
          diameter: k.diameter,
          roughness: k.roughness,
          minorLoss: k.minorLoss,
          pipeStatus: idx(PIPE_STATUS, k.status),
          leakArea: k.leakage ? k.leakage[0] : NaN,
          leakExpansion: k.leakage ? k.leakage[1] : NaN,
          bulkCoeff: nan(k.bulkCoeff),
          wallCoeff: nan(k.wallCoeff),
        },
      };
    case 'pump':
      return {
        kind: 'pump',
        values: {
          ...base,
          pumpCurveType: k.curve === null ? 0 : k.curve.type === 'head' ? 1 : 2,
          pumpCurve: k.curve?.type === 'head' ? k.curve.value : null,
          power: k.curve?.type === 'power' ? k.curve.value : 0,
          speed: k.speed,
          pattern: k.pattern,
          pumpStatus: idx(OPEN_CLOSED, k.status),
          price: nan(k.price),
          pricePattern: k.pricePattern,
          efficiencyCurve: k.efficiencyCurve,
        },
      };
    case 'valve':
      return {
        kind: 'valve',
        values: {
          ...base,
          valveType: idx(VALVE_TYPES, k.valveType),
          diameter: k.diameter,
          setting: k.setting.type === 'value' ? k.setting.value : 0,
          settingCurve: k.setting.type === 'curve' ? k.setting.value : null,
          minorLoss: k.minorLoss,
          pcvCurve: k.pcvCurve,
          fixedStatus: k.fixedStatus === null ? 0 : idx(FIXED_STATUS, k.fixedStatus),
        },
      };
  }
}

/** Fill a transaction with a model's contents (into an empty document). */
export function fillFromModel(tx: Tx, model: Model): void {
  const handles = new Map<string, number>();
  for (const n of model.nodes) {
    const { kind, values } = nodeValues(n);
    handles.set(n.id, tx.addNode(kind, values));
  }
  for (const l of model.links) {
    const { kind, values } = linkValues(l, (id) => {
      const h = handles.get(id);
      if (h === undefined) throw new Error(`link ${l.id} refers to unknown node ${id}`);
      return h;
    });
    tx.addLink(kind, values);
  }
  const data: DocData = {
    title: model.title,
    patterns: model.patterns,
    curves: model.curves,
    controls: model.controls,
    rules: model.rules,
    options: model.options,
    times: model.times,
    report: model.report,
    energy: model.energy,
    reactions: model.reactions,
    backdrop: model.backdrop,
    labels: model.labels,
    extraSections: model.extraSections,
    isolationValves: [],
    msx: null,
  };
  for (const [k, v] of Object.entries(data)) tx.setDoc(k as keyof DocData, v as never);
}

/** Open a model in a store: replaces its contents and clears history. */
export function loadModel(store: Store, model: Model): void {
  if (store.doc.nodes.liveCount + store.doc.links.liveCount > 0) {
    throw new Error('loadModel needs an empty document; create a new Store');
  }
  store.load((tx) => {
    fillFromModel(tx, model);
  });
}

function nodeToModel(doc: Document, h: number): MNode {
  const g = (f: string) => doc.get(h, f);
  const n = (f: string) => doc.num(h, f);
  const x = n('x');
  const y = n('y');
  let kind: MNodeKind;
  switch (doc.nodeKind(h)) {
    case 'junction':
      kind = {
        type: 'junction',
        elevation: n('elevation'),
        demands: g('demands') as Extract<MNodeKind, { type: 'junction' }>['demands'],
        emitter: opt(n('emitter')),
      };
      break;
    case 'reservoir':
      kind = { type: 'reservoir', head: n('head'), pattern: doc.str(h, 'headPattern'), level: n('level') };
      break;
    case 'tank': {
      const o = n('overflow');
      kind = {
        type: 'tank',
        elevation: n('elevation'),
        initLevel: n('initLevel'),
        minLevel: n('minLevel'),
        maxLevel: n('maxLevel'),
        diameter: n('diameter'),
        minVolume: n('minVolume'),
        volumeCurve: doc.str(h, 'volumeCurve'),
        overflow: OVERFLOW[o] === 'unset' ? null : OVERFLOW[o] === 'yes',
        mixing: g('mixing') as Extract<MNodeKind, { type: 'tank' }>['mixing'],
        bulkCoeff: opt(n('bulkCoeff')),
      };
      break;
    }
  }
  return {
    id: doc.id(h),
    kind,
    comment: doc.str(h, 'comment'),
    tag: doc.str(h, 'tag'),
    coordinates: Number.isNaN(x) || Number.isNaN(y) ? null : [x, y],
    initialQuality: opt(n('initialQuality')),
    source: g('source') as MNode['source'],
  };
}

function pairs(flat: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i]!, flat[i + 1]!]);
  return out;
}

function linkToModel(doc: Document, h: number): MLink {
  const n = (f: string) => doc.num(h, f);
  const s = (f: string) => doc.str(h, f);
  let kind: MLinkKind;
  switch (doc.linkKind(h)) {
    case 'pipe': {
      const a = n('leakArea');
      kind = {
        type: 'pipe',
        length: n('length'),
        diameter: n('diameter'),
        roughness: n('roughness'),
        minorLoss: n('minorLoss'),
        status: PIPE_STATUS[n('pipeStatus')] as PipeStatus,
        leakage: Number.isNaN(a) ? null : [a, n('leakExpansion')],
        bulkCoeff: opt(n('bulkCoeff')),
        wallCoeff: opt(n('wallCoeff')),
      };
      break;
    }
    case 'pump': {
      const ct = PUMP_CURVE_TYPES[n('pumpCurveType')];
      kind = {
        type: 'pump',
        curve:
          ct === 'head'
            ? { type: 'head', value: s('pumpCurve') ?? '' }
            : ct === 'power'
              ? { type: 'power', value: n('power') }
              : null,
        speed: n('speed'),
        pattern: s('pattern'),
        status: OPEN_CLOSED[n('pumpStatus')] as OpenClosed,
        price: opt(n('price')),
        pricePattern: s('pricePattern'),
        efficiencyCurve: s('efficiencyCurve'),
      };
      break;
    }
    case 'valve': {
      const curve = s('settingCurve');
      const fixed = FIXED_STATUS[n('fixedStatus')];
      kind = {
        type: 'valve',
        valveType: VALVE_TYPES[n('valveType')] as ValveType,
        diameter: n('diameter'),
        setting: curve !== null ? { type: 'curve', value: curve } : { type: 'value', value: n('setting') },
        minorLoss: n('minorLoss'),
        pcvCurve: s('pcvCurve'),
        fixedStatus: fixed === 'none' || fixed === undefined ? null : fixed,
      };
      break;
    }
  }
  return {
    id: doc.id(h),
    from: doc.id(n('from')),
    to: doc.id(n('to')),
    kind,
    comment: s('comment'),
    tag: s('tag'),
    vertices: pairs(doc.get(h, 'vertices') as number[]),
  };
}

/** The document as a canonical model, ready for the engine or for writing as .inp. */
export function toModel(doc: Document): Model {
  const d = doc.data;
  return {
    title: d.title,
    nodes: Array.from(doc.nodeHandles(), (h) => nodeToModel(doc, h)),
    links: Array.from(doc.linkHandles(), (h) => linkToModel(doc, h)),
    patterns: d.patterns,
    curves: d.curves,
    controls: d.controls,
    rules: d.rules,
    options: d.options,
    times: d.times,
    report: d.report,
    energy: d.energy,
    reactions: d.reactions,
    backdrop: d.backdrop,
    labels: d.labels,
    extraSections: d.extraSections,
  };
}

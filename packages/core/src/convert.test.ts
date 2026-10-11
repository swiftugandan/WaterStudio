import { describe, expect, it } from 'vitest';
import { loadModel, toModel } from './convert.ts';
import type { Model } from './generated/model.ts';
import { Store } from './store.ts';
import { unitSystem, unitLabel } from './units.ts';

const section = (lines: string[][]) => ({ lines: lines.map((tokens) => ({ tokens, comment: null })) });

const MODEL: Model = {
  title: ['Test'],
  nodes: [
    {
      id: 'J1',
      kind: {
        type: 'junction',
        elevation: 10,
        demands: [{ base: 5, pattern: 'P', category: 'Homes' }],
        emitter: null,
      },
      comment: 'first',
      tag: null,
      coordinates: [1, 2],
      initialQuality: 0.5,
      source: null,
    },
    {
      id: 'R',
      kind: { type: 'reservoir', head: 100, pattern: null, level: 0 },
      comment: null,
      tag: 'src',
      coordinates: null,
      initialQuality: null,
      source: { kind: 'setpoint', strength: 1, pattern: null },
    },
    {
      id: 'T',
      kind: {
        type: 'tank',
        elevation: 50,
        initLevel: 4,
        minLevel: 1,
        maxLevel: 9,
        diameter: 15,
        minVolume: 0,
        volumeCurve: 'V',
        overflow: true,
        mixing: { model: 'twoComp', fraction: 0.25 },
        bulkCoeff: -0.4,
      },
      comment: null,
      tag: null,
      coordinates: [3, 4],
      initialQuality: null,
      source: null,
    },
  ],
  links: [
    {
      id: 'P1',
      from: 'R',
      to: 'J1',
      kind: {
        type: 'pipe',
        length: 100,
        diameter: 8,
        roughness: 120,
        minorLoss: 0.5,
        status: 'checkValve',
        leakage: [0.5, 0.1],
        bulkCoeff: null,
        wallCoeff: -0.2,
      },
      comment: null,
      tag: null,
      vertices: [
        [1, 1],
        [2, 2],
      ],
    },
    {
      id: 'PU',
      from: 'J1',
      to: 'T',
      kind: {
        type: 'pump',
        curve: { type: 'head', value: 'C' },
        speed: 0.9,
        pattern: null,
        status: 'closed',
        price: 0.15,
        pricePattern: 'P',
        efficiencyCurve: null,
      },
      comment: null,
      tag: null,
      vertices: [],
    },
    {
      id: 'V',
      from: 'J1',
      to: 'T',
      kind: {
        type: 'valve',
        valveType: 'gpv',
        diameter: 6,
        setting: { type: 'curve', value: 'L' },
        minorLoss: 0,
        pcvCurve: null,
        fixedStatus: 'open',
      },
      comment: null,
      tag: null,
      vertices: [],
    },
    {
      id: 'PW',
      from: 'R',
      to: 'T',
      kind: {
        type: 'pump',
        curve: { type: 'power', value: 15 },
        speed: 1,
        pattern: null,
        status: 'open',
        price: null,
        pricePattern: null,
        efficiencyCurve: null,
      },
      comment: null,
      tag: null,
      vertices: [],
    },
  ],
  patterns: [{ id: 'P', comment: null, multipliers: [1, 2] }],
  curves: [{ id: 'C', comment: null, kind: 'pump', points: [[0, 10]] }],
  controls: [{ tokens: ['LINK', 'P1', 'OPEN', 'AT', 'TIME', '2'], comment: null }],
  rules: [{ name: 'R1', lines: ['RULE R1'] }],
  options: section([
    ['Units', 'LPS'],
    ['Headloss', 'D-W'],
  ]),
  times: section([['Duration', '24']]),
  report: section([]),
  energy: section([]),
  reactions: section([]),
  backdrop: section([]),
  labels: [{ x: 1, y: 2, text: 'hi', anchor: null }],
  extraSections: [{ header: '[CUSTOM]', lines: ['x'] }],
};

describe('model conversion', () => {
  it('round-trips every field', () => {
    const store = new Store();
    loadModel(store, MODEL);
    expect(toModel(store.doc)).toEqual(MODEL);
    expect(store.canUndo).toBe(false);
  });

  it('reads the unit system from the options', () => {
    const u = unitSystem(MODEL.options);
    expect(u).toEqual({
      flow: 'LPS',
      si: true,
      headloss: 'D-W',
      pressure: 'METERS',
      quality: { kind: 'none', name: '', units: '' },
    });
    expect(unitLabel('diameter', u)).toBe('mm');
    expect(unitLabel('roughness', u)).toBe('mm');
    const us = unitSystem(section([]));
    expect(us.flow).toBe('GPM');
    expect(unitLabel('pressure', us)).toBe('psi');
    expect(unitSystem(section([['UNITS', 'si']])).flow).toBe('LPS');
  });

  it('reads the quality analysis and labels quality in its units', () => {
    const q = (...t: string[]) => unitSystem(section([['QUALITY', ...t]]));
    expect(q('Chlorine', 'ug/L').quality).toEqual({ kind: 'chemical', name: 'Chlorine', units: 'ug/L' });
    expect(q('chem').quality.units).toBe('mg/L');
    expect(unitLabel('concentration', q('Age'))).toBe('hrs');
    expect(q('Trace', 'R1').quality).toEqual({ kind: 'trace', name: 'Trace R1', units: '%' });
    expect(q('None').quality.kind).toBe('none');
  });
});

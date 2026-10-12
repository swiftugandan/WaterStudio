import init from '@sqlite.org/sqlite-wasm';
import {
  addLink,
  addNode,
  loadModel,
  Scenarios,
  setField,
  Store,
  toModel,
  writeOption,
} from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { restoreScenarios, storeScenarios, type ProjectData } from './project.ts';
import {
  APPLICATION_ID,
  decode,
  encode,
  FORMAT_VERSION,
  isSqlite,
  ProjectError,
  readProject,
  writeProject,
} from './sqlite.ts';

const sqlite3 = await init();
const META = { application: 'WaterStudio test', saved: '2026-10-12T00:00:00.000Z' };

function net() {
  const store = new Store();
  const a = addNode(store, 'junction', { x: 0, y: 0, id: 'A', values: { elevation: 10 } });
  const b = addNode(store, 'junction', { x: 1, y: 0, id: 'Bé2', values: { elevation: 20 } });
  addNode(store, 'reservoir', { x: -1, y: 0, id: 'R', values: { head: 50 } });
  const p = addLink(store, 'pipe', { from: a, to: b, id: 'P', values: { diameter: 12, length: 100 } });
  return { store, a, b, p, sc: new Scenarios(store) };
}

function capture(store: Store, sc: Scenarios): ProjectData {
  return {
    fileName: 'test.inp',
    model: toModel(store.doc),
    scenarios: storeScenarios(store.doc, sc.toJSON()),
    isolationValves: [{ link: 'P', node: 'A' }],
    msx: { name: 'x.msx', text: '[SPECIES]\nBULK CL MG\n' },
    settings: { theme: 'dark', time: 3, colourBy: { node: 'pressure' } },
  };
}

describe('lossless JSON', () => {
  it('keeps NaN, infinities and negative zero', () => {
    const v = {
      a: [NaN, Infinity, -Infinity, -0, 0, 0.1 + 0.2, 1e-310],
      s: '\u0000NaN',
      t: '\u0000\u0000x',
      o: { $f: 'x', y: 1 },
    };
    const back = decode(encode(v)) as typeof v;
    expect(back.a.map((x) => (Object.is(x, -0) ? '-0' : x))).toEqual([
      NaN,
      Infinity,
      -Infinity,
      '-0',
      0,
      0.1 + 0.2,
      1e-310,
    ]);
    expect(back.s).toBe('\u0000NaN');
    expect(back.t).toBe('\u0000\u0000x');
    // Without anything special the text is plain JSON.
    expect(encode({ a: [1.5, 'x'] })).toBe('{"a":[1.5,"x"]}');
    expect(back.o).toEqual({ $f: 'x', y: 1 });
  });
});

describe('project file', () => {
  it('writes a SQLite database with the application ID and version', () => {
    const { store, sc } = net();
    const bytes = writeProject(sqlite3, capture(store, sc), META);
    expect(isSqlite(bytes)).toBe(true);
    // The header stores application_id at offset 68 and user_version at 60, big-endian.
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint32(68)).toBe(APPLICATION_ID);
    expect(view.getUint32(60)).toBe(FORMAT_VERSION);
  });

  it('round-trips the network, scenarios and extras', () => {
    const { store, a, p, sc } = net();
    const big = sc.create('Bigger pipes');
    sc.activate(big);
    setField(store, [p], 'diameter', 16);
    const child = sc.create('Higher', big);
    sc.activate(child);
    setField(store, [a], 'elevation', 15);
    store.transact('opts', (tx) =>
      tx.setDoc('options', writeOption(store.doc.data.options, 'trials', ['99'])),
    );
    const data = capture(store, sc);

    const back = readProject(sqlite3, writeProject(sqlite3, data, META));
    expect(back.meta).toEqual(META);
    expect(back.model).toEqual(data.model);
    expect(back.scenarios).toEqual(data.scenarios);
    expect(back.isolationValves).toEqual(data.isolationValves);
    expect(back.msx).toEqual(data.msx);
    expect(back.settings).toEqual(data.settings);
    expect(back.fileName).toBe('test.inp');

    // Open it in a fresh session: handles differ, scenarios still apply.
    const s2 = new Store();
    s2.doc.newHandle(); // shift the handles
    loadModel(s2, back.model);
    const sc2 = new Scenarios(s2);
    sc2.load(restoreScenarios(s2.doc, back.scenarios!));
    const d = s2.doc;
    const a2 = d.findNode('A')!;
    const p2 = d.findLink('P')!;
    expect(a2).not.toBe(a);
    expect(sc2.active).toBe(child);
    expect([d.num(p2, 'diameter'), d.num(a2, 'elevation')]).toEqual([16, 15]);
    sc2.activate(big);
    expect([d.num(p2, 'diameter'), d.num(a2, 'elevation')]).toEqual([16, 10]);
    sc2.activate(null);
    expect([d.num(p2, 'diameter'), d.num(a2, 'elevation')]).toEqual([12, 10]);
    expect(d.data.options.lines).toHaveLength(0);
    expect(sc2.scenarios.map((s) => s.name)).toEqual(['Bigger pipes', 'Higher']);
  });

  it('offers nodes and links as plain tables to other tools', () => {
    const { store, sc } = net();
    const bytes = writeProject(sqlite3, capture(store, sc), META);
    const db = new sqlite3.oo1.DB(':memory:');
    const p = sqlite3.wasm.allocFromTypedArray(bytes);
    const { capi } = sqlite3;
    capi.sqlite3_deserialize(
      db.pointer!,
      'main',
      p,
      bytes.length,
      bytes.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE,
    );
    expect(db.selectArrays('SELECT id, kind, x, y, elevation FROM nodes ORDER BY id')).toEqual([
      ['A', 'junction', 0, 0, 10],
      ['Bé2', 'junction', 1, 0, 20],
      ['R', 'reservoir', -1, 0, 50],
    ]);
    expect(db.selectArrays('SELECT * FROM links')).toEqual([['P', 'pipe', 'A', 'Bé2', 100, 12]]);
    db.close();
  });

  it('keeps a project without scenarios free of them', () => {
    const { store } = net();
    const data: ProjectData = {
      fileName: '',
      model: toModel(store.doc),
      scenarios: null,
      isolationValves: [],
      msx: null,
      settings: {},
    };
    const back = readProject(sqlite3, writeProject(sqlite3, data, META));
    expect(back.scenarios).toBeNull();
    expect(back.isolationValves).toEqual([]);
    expect(back.msx).toBeNull();
  });

  it('refuses what is not a project', () => {
    expect(() => readProject(sqlite3, new TextEncoder().encode('[JUNCTIONS]\n'))).toThrow(ProjectError);
    // Another SQLite database.
    const db = new sqlite3.oo1.DB(':memory:');
    db.exec('CREATE TABLE t(a)');
    const other = sqlite3.capi.sqlite3_js_db_export(db);
    db.close();
    expect(() => readProject(sqlite3, other)).toThrow('not a WaterStudio project');
    // A newer format.
    const { store, sc } = net();
    const bytes = writeProject(sqlite3, capture(store, sc), META);
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(60, FORMAT_VERSION + 1);
    expect(() => readProject(sqlite3, bytes)).toThrow('newer WaterStudio');
    // A truncated file.
    const cut = writeProject(sqlite3, capture(store, sc), META).slice(0, 2048);
    expect(() => readProject(sqlite3, cut)).toThrow(ProjectError);
  });
});

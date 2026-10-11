import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadModel, Store, toModel } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { EngineError } from './protocol.ts';
import { linkFrame, linkSeries, nodeFrame, nodeSeries } from './results.ts';
import { instantiateEngine } from './wasm.ts';

const wasmPath = new URL('../wasm/ws_wasm.wasm', import.meta.url);
const have = existsSync(wasmPath);
if (!have && process.env['CI']) throw new Error('wasm/ws_wasm.wasm is missing; run `pnpm build:engine`');

const NET = `[RESERVOIRS]
 R 200
[JUNCTIONS]
 J1 100 10
 J2 90 20
[PIPES]
 P1 R J1 1000 12 100
 P2 J1 J2 1000 10 100
[TIMES]
 Duration 2:00
[OPTIONS]
 Units GPM
[END]
`;

// Networks shipped with the app and our oracle fixtures.
const root = new URL('../../../', import.meta.url);
const networks = [
  ...['Net1', 'Net2', 'Net3'].map((n) => new URL(`apps/web/public/samples/${n}.inp`, root)),
  ...readdirSync(new URL('oracle/fixtures/', root)).map((f) => new URL(`oracle/fixtures/${f}`, root)),
];

describe.skipIf(!have)('WebAssembly engine', async () => {
  const engine = have ? await instantiateEngine(readFileSync(wasmPath)) : undefined;
  const e = () => engine!;

  it('reads an .inp file into the model', () => {
    const { model, issues } = e().readInp(NET);
    expect(issues).toEqual([]);
    expect(model.nodes.map((n) => n.id)).toEqual(['R', 'J1', 'J2']);
    expect(model.nodes[1]!.kind).toEqual({
      type: 'junction',
      elevation: 100,
      demands: [{ base: 10, pattern: null, category: null }],
      emitter: null,
    });
  });

  it('reports input problems as issues', () => {
    const { issues } = e().readInp(NET.replace(' P2 J1 J2', ' P2 J1 J9'));
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('J9'))).toBe(true);
  });

  it('runs a model and returns columns in model order', () => {
    const { model } = e().readInp(NET);
    const r = e().run(model);
    expect([r.nodeCount, r.linkCount, r.times]).toEqual([3, 2, [0, 3600, 7200]]);
    expect(nodeFrame(r, 'head', 0)[0]).toBe(200); // R is first in the model
    expect(nodeFrame(r, 'demand', 1)[0]).toBeCloseTo(-30, 4);
    expect(linkFrame(r, 'flow', 2)[0]).toBeCloseTo(30, 4);
    expect(nodeSeries(r, 'pressure', 2)).toHaveLength(3);
    expect(Array.from(linkSeries(r, 'status', 0))).toEqual([3, 3, 3]); // OPEN
    expect(linkFrame(r, 'velocity', 0)[1]!).toBeGreaterThan(0);
  });

  it('reports EPANET errors', () => {
    const { model } = e().readInp(NET);
    model.links[1]!.to = 'J9';
    expect(() => e().run(model)).toThrow(EngineError);
  });

  for (const url of networks) {
    const name = url.pathname.split('/').pop()!;
    it(`${name}: model -> document -> model is lossless, and the engine agrees`, () => {
      const text = readFileSync(url, 'latin1');
      const { model } = e().readInp(text);
      const store = new Store();
      loadModel(store, model);
      const back = toModel(store.doc);
      expect(back).toEqual(model);
      expect(e().writeInp(back)).toBe(e().writeInp(model));
      // The document's model solves exactly as the file does.
      const a = e().run(model);
      const b = e().run(back);
      expect(b.node.head).toEqual(a.node.head);
      expect(b.link.flow).toEqual(a.link.flow);
    });
  }

  it('gives the same bits every time', () => {
    const { model } = e().readInp(readFileSync(networks[2]!, 'latin1'));
    expect(e().run(model).link.flow).toEqual(e().run(model).link.flow);
  });
});

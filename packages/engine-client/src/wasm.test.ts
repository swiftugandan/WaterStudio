import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { loadModel, Store, toModel } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { readOutFile } from './outfile.ts';
import { EngineError } from './protocol.ts';
import { linkFrame, linkSeries, nodeFrame, nodeSeries, speciesVariable } from './results.ts';
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
  ...readdirSync(new URL('oracle/fixtures/', root))
    .filter((f) => f.endsWith('.inp'))
    .map((f) => new URL(`oracle/fixtures/${f}`, root)),
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
    expect(issues.some((i) => i.severity === 'error' && i.code === 203 && i.message.includes('J9'))).toBe(
      true,
    );
  });

  it('runs an EPANET-MSX analysis and adds each species to the results', () => {
    // Long enough for the reservoir's water to reach J1.
    const { model } = e().readInp(NET.replace('Duration 2:00', 'Duration 6:00'));
    const msx = `[SPECIES]\nBULK CL MG\nWALL B UG\n[PIPES]\nRATE CL -0.5*CL\nRATE B 0.1\n[TANKS]\nRATE CL -0.5*CL\n[QUALITY]\nNODE R CL 1.0\n`;
    const r = e().msx({ model, msx, fileName: 'test.msx' });
    expect(r.msx?.species.map((s) => [s.id, s.kind, s.units])).toEqual([
      ['CL', 'bulk', 'MG/L'],
      ['B', 'wall', 'UG/FT2'],
    ]);
    expect(nodeFrame(r, speciesVariable('CL'), 6)[0]).toBe(1); // the reservoir
    expect(nodeFrame(r, speciesVariable('CL'), 6)[1]).toBeGreaterThan(0);
    expect(linkFrame(r, speciesVariable('B'), 6)[0]).toBeGreaterThan(0);
    expect(nodeFrame(r, 'pressure', 0)[1]).toBeGreaterThan(0); // hydraulics come too
  });

  it('reports MSX input errors with their lines', () => {
    const { model } = e().readInp(NET);
    expect(() =>
      e().msx({ model, msx: '[SPECIES]\nBULK CL MG\n[PIPES]\nRATE CL -k*CL\n', fileName: 'x.msx' }),
    ).toThrow(/Error 409 \(illegal math expression\) at line 4/);
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

  it("writes EPANET's report and output file", () => {
    const text = readFileSync(new URL('apps/web/public/samples/Net1.inp', root), 'utf8');
    const { model } = e().readInp(text);
    const date = 'Sun Oct 11 02:12:12 2026';
    const files = e().runFiles({ model, inpName: 'Net1.inp', date, statusLog: false });
    expect(files.report).toContain(`Analysis begun ${date}`);
    expect(files.report).toContain('Balanced after 4 trials'); // Net1 asks for a status report
    const out = readOutFile(files.out);
    expect([out.nodes, out.links, out.pumps, out.periods, out.warning]).toEqual([11, 13, 1, 25, 0]);
    expect(out.energy[0]!.link).toBe(12); // pump 9 is Net1's last link
    expect(out.energy[0]!.utilization).toBeGreaterThan(0);
    expect(out.reactions.bulk).toBeGreaterThan(0); // chlorine decays in Net1
    // The status log can be asked for even when [REPORT] turns it off.
    const quiet = { ...model, report: { lines: [{ tokens: ['Status', 'No'], comment: null }] } };
    expect(e().runFiles({ model: quiet, inpName: 'x', date, statusLog: false }).report).not.toContain(
      'Balanced',
    );
    expect(e().runFiles({ model: quiet, inpName: 'x', date, statusLog: true }).report).toContain('Balanced');
  });

  it('reports EPANET errors', () => {
    const { model } = e().readInp(NET);
    model.links[1]!.to = 'J9';
    expect(() => e().run(model)).toThrow(EngineError);
  });

  it('runs fire flow and criticality studies', () => {
    const text = readFileSync(new URL('apps/web/public/samples/Net1.inp', root), 'utf8');
    const { model } = e().readInp(text);
    const ff = e().study({ kind: 'fireFlow', model, options: { hydrants: ['32'], flow: 500, residual: 20 } });
    expect(ff).toHaveLength(1);
    expect(ff[0]).toMatchObject({ id: '32', meets: true, error: null });
    const cr = e().study({ kind: 'criticality', model, options: { links: ['111'], pressure: 100 } });
    expect(cr[0]).toMatchObject({ id: '111', failed: false });
  });

  it('checks a model without solving it', () => {
    const { model } = e().readInp(NET);
    expect(e().check(model)).toBeNull();
    const bad = {
      ...model,
      rules: [{ name: '1', lines: ['RULE 1', 'IF SYSTEM TIME > 2', 'THEN LINK P9 STATUS IS OPEN'] }],
    };
    expect(e().check(bad)).toMatch(/undefined link P9/);
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

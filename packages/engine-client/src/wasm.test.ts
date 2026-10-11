import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { EngineError } from './protocol.ts';
import { instantiateEngine } from './wasm.ts';

const wasmPath = new URL('../wasm/ws_wasm.wasm', import.meta.url);
const have = existsSync(wasmPath);
if (!have && process.env['CI']) throw new Error('wasm/ws_wasm.wasm is missing; run `pnpm build:engine`');

const NET = `[JUNCTIONS]
 J1 100 10
 J2 90 20
[RESERVOIRS]
 R 200
[PIPES]
 P1 R J1 1000 12 100
 P2 J1 J2 1000 10 100
[OPTIONS]
 Units GPM
[END]
`;

describe.skipIf(!have)('WebAssembly engine', async () => {
  const engine = have ? await instantiateEngine(readFileSync(wasmPath)) : undefined;

  it('solves a network', () => {
    const r = engine!.runHydraulicsInp(NET);
    expect(r.nodes).toEqual(['J1', 'J2', 'R']);
    expect(r.links).toEqual(['P1', 'P2']);
    expect(r.heads).toHaveLength(1);
    const [q1, q2] = r.flows[0]!;
    expect(q1).toBeCloseTo(30, 6);
    expect(q2).toBeCloseTo(20, 6);
    expect(r.demands[0]![2]).toBeCloseTo(-30, 6);
    expect(r.heads[0]![0]!).toBeLessThan(200);
  });

  it('reports EPANET errors', () => {
    expect(() => engine!.runHydraulicsInp(NET.replace(' P2 J1 J2', ' P2 J1 J9'))).toThrow(EngineError);
  });

  it('gives the same bits every time', () => {
    const a = engine!.runHydraulicsInp(NET);
    const b = engine!.runHydraulicsInp(NET);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

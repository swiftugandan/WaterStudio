#!/usr/bin/env node
// Determinism diagnostic: solves each network with the WebAssembly engine and with
// the native harness and reports how far apart they are. The goal (ADR 0003) is
// bit-identical results; today native libm, faer's runtime SIMD dispatch and FMA
// make them differ in late digits, so this is not yet a CI gate.
//
// usage: node scripts/check-wasm.mjs <engine.wasm> <ws-parity binary> <net.inp>...

import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const [wasmPath, nativeBin, ...networks] = process.argv.slice(2);
if (!wasmPath || !nativeBin || networks.length === 0) {
  console.error('usage: check-wasm.mjs <engine.wasm> <ws-parity> <net.inp>...');
  process.exit(2);
}

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const { memory, ws_alloc, ws_free, ws_run_hydraulics_inp } = instance.exports;

function solveWasm(text) {
  const input = new TextEncoder().encode(text);
  const ptr = ws_alloc(input.length);
  new Uint8Array(memory.buffer, ptr, input.length).set(input);
  const t0 = performance.now();
  const out = ws_run_hydraulics_inp(ptr, input.length);
  const ms = performance.now() - t0;
  ws_free(ptr, input.length);
  const head = new DataView(memory.buffer, out, 8);
  const status = head.getUint32(0, true);
  const len = head.getUint32(4, true);
  const body = new TextDecoder().decode(new Uint8Array(memory.buffer, out + 8, len));
  ws_free(out, 8 + len);
  return { status, body, ms };
}

// Largest difference in units of the value's magnitude (relative, floored at 1).
function maxRelDiff(a, b) {
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < a[i].length; j++) {
      const x = a[i][j], y = b[i][j];
      const d = Math.abs(x - y) / Math.max(1, Math.abs(x));
      if (d > worst) worst = d;
    }
  }
  return worst;
}

const work = await mkdtemp(join(tmpdir(), 'ws-wasm-'));
let failures = 0;
for (const net of networks) {
  const name = basename(net);
  // Decode as Latin-1 like the native reader's byte-oriented parse of these files.
  const text = new TextDecoder('latin1').decode(await readFile(net));
  const w = solveWasm(text);
  let native;
  try {
    const out = join(work, name + '.json');
    execFileSync(nativeBin, [net, out], { stdio: ['ignore', 'ignore', 'pipe'] });
    native = JSON.parse(await readFile(out, 'utf8'));
  } catch {
    native = null;
  }
  if (w.status !== 0 || !native) {
    const agree = (w.status !== 0) === !native;
    console.log(`${agree ? 'both-fail' : 'MISMATCH '} ${name}  wasm: ${w.status ? w.body.slice(0, 80) : 'ok'}`);
    if (!agree) failures++;
    continue;
  }
  const r = JSON.parse(w.body);
  const sameShape = r.heads.length === native.heads.length && r.flows.length === native.flows.length;
  const dh = sameShape ? maxRelDiff(native.heads, r.heads) : Infinity;
  const dq = sameShape ? maxRelDiff(native.flows, r.flows) : Infinity;
  const ok = dh <= 1e-12 && dq <= 1e-12;
  if (!ok) failures++;
  console.log(`${ok ? 'same     ' : 'DIFFERENT'} ${name}  heads ${dh.toExponential(1)}  flows ${dq.toExponential(1)}  ` +
    `wasm ${w.ms.toFixed(1)} ms vs native ${native.solve_ms.toFixed(1)} ms`);
}
await rm(work, { recursive: true, force: true });
console.log(`\n${networks.length - failures}/${networks.length} agree`);
process.exit(failures ? 1 : 0);

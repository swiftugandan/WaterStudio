#!/usr/bin/env node
// Same interface as the native `ws-parity` harness, but solves with the
// WebAssembly engine, so oracle/compare.py can check the build that ships.
//
// usage: ws-parity-wasm.mjs <network.inp> <result.json>
// The engine is read from $WS_ENGINE_WASM or the default release build path.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const wasmPath =
  process.env.WS_ENGINE_WASM ??
  join(here, '..', 'engine', 'target', 'wasm32-unknown-unknown', 'release', 'ws_wasm.wasm');
const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error('usage: ws-parity-wasm.mjs <network.inp> <result.json>');
  process.exit(2);
}

const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
const { memory, ws_alloc, ws_free, ws_run_hydraulics_inp } = instance.exports;
const bytes = await readFile(input);
const ptr = ws_alloc(bytes.length);
new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
const t0 = performance.now();
const out = ws_run_hydraulics_inp(ptr, bytes.length);
const solveMs = performance.now() - t0;
ws_free(ptr, bytes.length);
const view = new DataView(memory.buffer, out, 8);
const status = view.getUint32(0, true);
const len = view.getUint32(4, true);
const body = new TextDecoder().decode(new Uint8Array(memory.buffer, out + 8, len));
ws_free(out, 8 + len);
if (status !== 0) {
  console.error(body);
  process.exit(1);
}
const report = JSON.parse(body);
report.solve_ms = solveMs;
await writeFile(output, JSON.stringify(report));

/// <reference lib="webworker" />
/** Engine worker: one WebAssembly engine instance, one request at a time. */

import type { EngineRequest, EngineResponse } from './protocol.ts';
import { instantiateEngine, type Engine } from './wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let engine: Promise<Engine> | undefined;

function load(): Promise<Engine> {
  engine ??= fetch(new URL('../wasm/ws_wasm.wasm', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`could not load the engine (${r.status})`);
      return r.arrayBuffer();
    })
    .then((bytes) => instantiateEngine(bytes));
  return engine;
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const req = event.data;
  let reply: EngineResponse;
  try {
    const e = await load();
    const t0 = performance.now();
    const report = e.runHydraulicsInp(req.inp);
    reply = { id: req.id, ok: true, report, solveMs: performance.now() - t0 };
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply);
};

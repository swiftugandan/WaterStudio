/// <reference lib="webworker" />
/** Engine worker: one WebAssembly engine instance, one request at a time. */

import { handle } from './handle.ts';
import type { EngineRequest, EngineResponse } from './protocol.ts';
import { transferables } from './results.ts';
import { instantiateEngine, type Engine } from './wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let module: Promise<WebAssembly.Module> | undefined;
let engine: Promise<Engine> | undefined;
/** The resident model of a recycled instance, for the next one (ADR 0020). */
let carried: Uint8Array | null = null;
/** Whether the instance holds a document's model (ADR 0020). */
let holding = false;

/**
 * WebAssembly memory grows to a run's peak and never shrinks, so after a request that
 * took more than this the instance is dropped (its memory goes with it) and the next
 * request gets a fresh one from the compiled module, which takes about a millisecond.
 * An instance holding a document's model is kept to a higher mark, since a new one must
 * be given the model again: a 10,000-node run peaks near 80 MB, a 100,000-node one
 * near 800 MB.
 */
const RECYCLE_BYTES = 64 * 2 ** 20;
const RECYCLE_HOLDING_BYTES = 256 * 2 ** 20;

function load(): Promise<Engine> {
  module ??= fetch(new URL('../wasm/ws_wasm.wasm', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`could not load the engine (${r.status})`);
      return r.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes));
  engine ??= module
    .then((m) => instantiateEngine(m))
    .then((e) => {
      if (carried) e.sessionOpenBytes(carried);
      carried = null;
      return e;
    });
  return engine;
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const req = event.data;
  let reply: EngineResponse;
  let transfer: ArrayBuffer[] = [];
  try {
    const e = await load();
    const t0 = performance.now();
    const value = handle(e, req);
    reply = { id: req.id, ok: true, reply: value, ms: performance.now() - t0 };
    if (value.kind === 'session-open') holding = true;
    if (value.kind === 'run' || value.kind === 'msx') transfer = transferables(value.value);
    if (value.kind === 'run-files') transfer = [value.value.out.buffer as ArrayBuffer];
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, transfer);
  const e = await engine?.catch(() => undefined);
  if (!e) engine = undefined;
  else if (e.memoryBytes() > (holding ? RECYCLE_HOLDING_BYTES : RECYCLE_BYTES)) {
    // The resident model goes on in the fresh instance.
    carried = holding ? e.sessionExportBytes() : null;
    engine = undefined;
  }
};

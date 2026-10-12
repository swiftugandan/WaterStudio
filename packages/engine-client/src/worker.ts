/// <reference lib="webworker" />
/** Engine worker: one WebAssembly engine instance, one request at a time. */

import type { EngineReply, EngineRequest, EngineResponse } from './protocol.ts';
import { transferables } from './results.ts';
import { instantiateEngine, type Engine } from './wasm.ts';

declare const self: DedicatedWorkerGlobalScope;

let module: Promise<WebAssembly.Module> | undefined;
let engine: Promise<Engine> | undefined;

/**
 * WebAssembly memory grows to a run's peak and never shrinks, so after a request that
 * took more than this the instance is dropped (its memory goes with it) and the next
 * request gets a fresh one from the compiled module, which takes about a millisecond.
 */
const RECYCLE_BYTES = 64 * 2 ** 20;

function load(): Promise<Engine> {
  module ??= fetch(new URL('../wasm/ws_wasm.wasm', import.meta.url))
    .then((r) => {
      if (!r.ok) throw new Error(`could not load the engine (${r.status})`);
      return r.arrayBuffer();
    })
    .then((bytes) => WebAssembly.compile(bytes));
  engine ??= module.then((m) => instantiateEngine(m));
  return engine;
}

function handle(e: Engine, req: EngineRequest): EngineReply {
  switch (req.kind) {
    case 'read-inp':
      return { kind: 'read-inp', value: e.readInp(req.inp) };
    case 'write-inp':
      return { kind: 'write-inp', value: e.writeInp(req.model) };
    case 'run':
      return { kind: 'run', value: e.run(req.model) };
    case 'run-hydraulics':
      return { kind: 'run-hydraulics', value: e.runHydraulicsInp(req.inp) };
    case 'run-files':
      return { kind: 'run-files', value: e.runFiles(req.request) };
    case 'study':
      return { kind: 'study', value: e.study(req.request) };
    case 'check':
      return { kind: 'check', value: e.check(req.model) };
    case 'msx':
      return { kind: 'msx', value: e.msx(req.request) };
  }
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
    if (value.kind === 'run' || value.kind === 'msx') transfer = transferables(value.value);
    if (value.kind === 'run-files') transfer = [value.value.out.buffer as ArrayBuffer];
  } catch (err) {
    reply = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(reply, transfer);
  const e = await engine?.catch(() => undefined);
  if (!e || e.memoryBytes() > RECYCLE_BYTES) engine = undefined;
};

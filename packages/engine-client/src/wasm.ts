/**
 * Synchronous access to one instance of the WebAssembly engine. Used inside workers and
 * in Node tests; the app talks to the engine through `EngineClient` instead.
 *
 * The boundary: copy request bytes into memory from `ws_alloc`, call an entry point,
 * read the reply it returns (u32 status, u32 length, then UTF-8 JSON), free it with
 * `ws_free(ptr, 8 + length)`.
 */

import { EngineError, type HydraulicReport } from './protocol.ts';

interface Exports {
  memory: WebAssembly.Memory;
  ws_alloc(len: number): number;
  ws_free(ptr: number, len: number): void;
  ws_run_hydraulics_inp(ptr: number, len: number): number;
}

export interface Engine {
  runHydraulicsInp(inp: string | Uint8Array): HydraulicReport;
}

export async function instantiateEngine(source: BufferSource | WebAssembly.Module): Promise<Engine> {
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, {})
      : (await WebAssembly.instantiate(source, {})).instance;
  const x = instance.exports as unknown as Exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  return {
    runHydraulicsInp(inp) {
      const bytes = typeof inp === 'string' ? encoder.encode(inp) : inp;
      const ptr = x.ws_alloc(bytes.length);
      if (ptr === 0) throw new EngineError('engine out of memory');
      new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
      const out = x.ws_run_hydraulics_inp(ptr, bytes.length);
      x.ws_free(ptr, bytes.length);
      if (out === 0) throw new EngineError('engine out of memory');
      const view = new DataView(x.memory.buffer, out, 8);
      const status = view.getUint32(0, true);
      const len = view.getUint32(4, true);
      // Copy before freeing: decoding a view of freed memory is unsafe if it grows.
      const body = decoder.decode(new Uint8Array(x.memory.buffer, out + 8, len).slice());
      x.ws_free(out, 8 + len);
      if (status !== 0) throw new EngineError(body);
      return JSON.parse(body) as HydraulicReport;
    },
  };
}

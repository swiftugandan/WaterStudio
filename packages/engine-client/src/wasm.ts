/**
 * Synchronous access to one instance of the WebAssembly engine. Used inside workers and
 * in Node tests; the app talks to the engine through `EngineClient` instead.
 *
 * The boundary: copy request bytes into memory from `ws_alloc`, call an entry point,
 * read the reply it returns (u32 status, u32 length, then the body), free it with
 * `ws_free(ptr, 8 + length)`.
 */

import type { model } from '@waterstudio/core';
import {
  EngineError,
  type EpanetFiles,
  type FilesRequest,
  type HydraulicReport,
  type ReadResult,
} from './protocol.ts';
import { decodeResults, type RunResults } from './results.ts';

type Entry = (ptr: number, len: number) => number;

interface Exports {
  memory: WebAssembly.Memory;
  ws_alloc(len: number): number;
  ws_free(ptr: number, len: number): void;
  ws_read_inp: Entry;
  ws_write_inp: Entry;
  ws_run: Entry;
  ws_run_hydraulics_inp: Entry;
  ws_run_files: Entry;
  ws_check: Entry;
}

export interface Engine {
  readInp(inp: string | Uint8Array): ReadResult;
  writeInp(m: model.Model): string;
  run(m: model.Model): RunResults;
  runHydraulicsInp(inp: string | Uint8Array): HydraulicReport;
  runFiles(req: FilesRequest): EpanetFiles;
  /** The error EPANET's input stage would refuse the model with, or null. */
  check(m: model.Model): string | null;
}

export async function instantiateEngine(source: BufferSource | WebAssembly.Module): Promise<Engine> {
  const instance =
    source instanceof WebAssembly.Module
      ? await WebAssembly.instantiate(source, {})
      : (await WebAssembly.instantiate(source, {})).instance;
  const x = instance.exports as unknown as Exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function call(entry: Entry, input: Uint8Array): Uint8Array {
    const ptr = x.ws_alloc(input.length);
    if (ptr === 0) throw new EngineError('engine out of memory');
    new Uint8Array(x.memory.buffer, ptr, input.length).set(input);
    const out = entry(ptr, input.length);
    x.ws_free(ptr, input.length);
    if (out === 0) throw new EngineError('engine out of memory');
    const view = new DataView(x.memory.buffer, out, 8);
    const status = view.getUint32(0, true);
    const len = view.getUint32(4, true);
    // Copy before freeing.
    const body = new Uint8Array(x.memory.buffer, out + 8, len).slice();
    x.ws_free(out, 8 + len);
    if (status !== 0) throw new EngineError(decoder.decode(body));
    return body;
  }

  const bytes = (v: string | Uint8Array) => (typeof v === 'string' ? encoder.encode(v) : v);
  const json = (v: unknown) => encoder.encode(JSON.stringify(v));

  return {
    readInp: (inp) => JSON.parse(decoder.decode(call(x.ws_read_inp, bytes(inp)))) as ReadResult,
    writeInp: (m) => decoder.decode(call(x.ws_write_inp, json(m))),
    run: (m) => decodeResults(call(x.ws_run, json(m))),
    runHydraulicsInp: (inp) =>
      JSON.parse(decoder.decode(call(x.ws_run_hydraulics_inp, bytes(inp)))) as HydraulicReport,
    runFiles: (req) => {
      const body = call(x.ws_run_files, json(req));
      const n = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
      return { report: decoder.decode(body.subarray(4, 4 + n)), out: body.slice(4 + n) };
    },
    check: (m) => {
      try {
        call(x.ws_check, json(m));
        return null;
      } catch (e) {
        if (e instanceof EngineError) return e.message;
        throw e;
      }
    },
  };
}

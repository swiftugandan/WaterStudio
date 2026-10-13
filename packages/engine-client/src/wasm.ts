/**
 * Synchronous access to one instance of the WebAssembly engine. Used inside workers and
 * in Node tests; the app talks to the engine through `EngineClient` instead.
 *
 * The boundary: copy request bytes into memory from `ws_alloc`, call an entry point,
 * read the reply it returns (u32 status, u32 length, then the body), free it with
 * `ws_free(ptr, 8 + length)`.
 */

import type { CriticalityResult, FireFlowResult, StudyRequest } from './study.ts';
import type { model } from '@waterstudio/core';
import {
  EngineError,
  isSessionRef,
  type EpanetFiles,
  type FilesRequest,
  type HydraulicReport,
  type ModelSource,
  type MsxRequest,
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
  ws_study: Entry;
  ws_msx: Entry;
  ws_session: Entry;
}

/**
 * One engine instance. Requests take a model, or a reference to the model the instance
 * holds (`sessionOpen`, then `sessionPatch` after each edit; ADR 0020).
 */
export interface Engine {
  readInp(inp: string | Uint8Array): ReadResult;
  writeInp(m: model.Model): string;
  run(m: ModelSource): RunResults;
  runHydraulicsInp(inp: string | Uint8Array): HydraulicReport;
  runFiles(req: FilesRequest): EpanetFiles;
  /** The error EPANET's input stage would refuse the model with, or null. */
  check(m: ModelSource): string | null;
  /** Hold this model from now on. */
  sessionOpen(s: model.Snapshot): void;
  /** Bring the held model to a later revision. */
  sessionPatch(p: model.ModelPatch): void;
  /** The held model, to carry it to another instance; null if none. */
  sessionExport(): model.Snapshot | null;
  study(req: StudyRequest): FireFlowResult[] | CriticalityResult[];
  /** Hydraulics and an EPANET-MSX analysis: the run's results with the species added. */
  msx(req: MsxRequest): RunResults;
  /** Size of the instance's linear memory, which grows to a run's peak and never shrinks. */
  memoryBytes(): number;
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

  const session = (cmd: unknown) => call(x.ws_session, json(cmd));
  /** A request on a model: sent whole, or as a reference to the held one. */
  const on = <T>(
    m: ModelSource,
    whole: (m: model.Model) => T,
    held: (ref: { epoch: number; rev: number }) => T,
  ): T => (isSessionRef(m) ? held({ epoch: m.epoch, rev: m.rev }) : whole(m));
  const files = (body: Uint8Array): EpanetFiles => {
    const n = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
    return { report: decoder.decode(body.subarray(4, 4 + n)), out: body.slice(4 + n) };
  };

  return {
    readInp: (inp) => JSON.parse(decoder.decode(call(x.ws_read_inp, bytes(inp)))) as ReadResult,
    writeInp: (m) => decoder.decode(call(x.ws_write_inp, json(m))),
    run: (m) =>
      decodeResults(
        on(
          m,
          (whole) => call(x.ws_run, json(whole)),
          (ref) => session({ op: 'run', ...ref }),
        ),
      ),
    runHydraulicsInp: (inp) =>
      JSON.parse(decoder.decode(call(x.ws_run_hydraulics_inp, bytes(inp)))) as HydraulicReport,
    runFiles: (req) => {
      const { model: m, ...options } = req;
      return files(
        on(
          m,
          (whole) => call(x.ws_run_files, json({ ...options, model: whole })),
          (ref) => session({ op: 'files', ...ref, options }),
        ),
      );
    },
    msx: (req) => {
      const { model: m, ...options } = req;
      return decodeResults(
        on(
          m,
          (whole) => call(x.ws_msx, json({ ...options, model: whole })),
          (ref) => session({ op: 'msx', ...ref, options }),
        ),
      );
    },
    study: (req) => {
      const { model: m, ...study } = req;
      const body = on(
        m,
        (whole) => call(x.ws_study, json({ ...study, model: whole })),
        (ref) => session({ op: 'study', ...ref, study }),
      );
      return JSON.parse(decoder.decode(body)) as FireFlowResult[] | CriticalityResult[];
    },
    memoryBytes: () => x.memory.buffer.byteLength,
    check: (m) => {
      try {
        on(
          m,
          (whole) => call(x.ws_check, json(whole)),
          (ref) => session({ op: 'check', ...ref }),
        );
        return null;
      } catch (e) {
        // A stale reference is not a verdict on the model.
        if (e instanceof EngineError && !e.message.startsWith('stale session')) return e.message;
        throw e;
      }
    },
    sessionOpen: (snapshot) => void session({ op: 'open', snapshot }),
    sessionPatch: (patch) => void session({ op: 'patch', patch }),
    sessionExport: () => JSON.parse(decoder.decode(session({ op: 'export' }))) as model.Snapshot | null,
  };
}

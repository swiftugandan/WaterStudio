/**
 * The app's handle on the engine: a small pool of workers, each with its own engine
 * instance, behind a promise-based API. Requests go to the least busy worker.
 */

import type { CriticalityResult, FireFlowResult, StudyRequest, StudyResult } from './study.ts';
import type { model } from '@waterstudio/core';
import {
  EngineError,
  type EngineReply,
  type EngineRequest,
  type EngineResponse,
  type EpanetFiles,
  type FilesRequest,
  type HydraulicReport,
  type ReadResult,
} from './protocol.ts';
import type { RunResults } from './results.ts';

export interface Timed<T> {
  value: T;
  /** Time spent inside the worker, in milliseconds. */
  ms: number;
}

interface Pending {
  resolve: (r: Timed<EngineReply>) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  pending: Map<number, Pending>;
}

export type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ws-engine' });

interface Replies {
  'read-inp': ReadResult;
  'write-inp': string;
  run: RunResults;
  'run-hydraulics': HydraulicReport;
  'run-files': EpanetFiles;
  check: string | null;
  study: FireFlowResult[] | CriticalityResult[];
}

type Body = EngineRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

export class EngineClient {
  private readonly slots: Slot[];
  private nextId = 1;

  constructor(options: { workers?: number; factory?: WorkerFactory } = {}) {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2;
    const count = Math.max(1, Math.min(options.workers ?? Math.min(4, hw - 1), 8));
    const factory = options.factory ?? defaultFactory;
    this.slots = Array.from({ length: count }, () => this.spawn(factory));
  }

  private spawn(factory: WorkerFactory): Slot {
    const slot: Slot = { worker: factory(), pending: new Map() };
    slot.worker.onmessage = (event: MessageEvent<EngineResponse>) => {
      const res = event.data;
      const p = slot.pending.get(res.id);
      if (!p) return;
      slot.pending.delete(res.id);
      if (res.ok) p.resolve({ value: res.reply, ms: res.ms });
      else p.reject(new EngineError(res.error));
    };
    slot.worker.onerror = (event) => {
      const err = new EngineError(event.message || 'engine worker failed');
      for (const p of slot.pending.values()) p.reject(err);
      slot.pending.clear();
    };
    return slot;
  }

  get size(): number {
    return this.slots.length;
  }

  private request(body: Body): Promise<Timed<EngineReply>> {
    const slot = this.slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    const id = this.nextId++;
    const req = { ...body, id };
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage(req);
    });
  }

  private async typed<K extends keyof Replies>(body: Body & { kind: K }): Promise<Timed<Replies[K]>> {
    const r = await this.request(body);
    if (r.value.kind !== body.kind) throw new EngineError(`unexpected reply ${r.value.kind}`);
    return { value: r.value.value as Replies[K], ms: r.ms };
  }

  /** Read an EPANET .inp file into the canonical model, with any issues found. */
  readInp(inp: string): Promise<Timed<ReadResult>> {
    return this.typed({ kind: 'read-inp', inp });
  }

  /** Write the canonical model as .inp text. */
  writeInp(m: model.Model): Promise<Timed<string>> {
    return this.typed({ kind: 'write-inp', model: m });
  }

  /** Solve a model's hydraulics over its whole duration. */
  run(m: model.Model): Promise<Timed<RunResults>> {
    return this.typed({ kind: 'run', model: m });
  }

  /** Solve an .inp file, returning the parity harness's JSON report. */
  runHydraulicsInp(inp: string): Promise<Timed<HydraulicReport>> {
    return this.typed({ kind: 'run-hydraulics', inp });
  }

  /** Run a model as EPANET's runepanet does, for its report and output file. */
  runFiles(request: FilesRequest): Promise<Timed<EpanetFiles>> {
    return this.typed({ kind: 'run-files', request });
  }

  /** Run a study on one worker; split long lists across workers with several calls. */
  study<R extends StudyRequest>(request: R): Promise<Timed<StudyResult<R>>> {
    return this.typed({ kind: 'study', request }) as Promise<Timed<StudyResult<R>>>;
  }

  /** The error EPANET would refuse the model with (bad controls or rules, say), or null. */
  check(m: model.Model): Promise<Timed<string | null>> {
    return this.typed({ kind: 'check', model: m });
  }

  dispose(): void {
    for (const s of this.slots) {
      s.worker.terminate();
      for (const p of s.pending.values()) p.reject(new EngineError('engine stopped'));
      s.pending.clear();
    }
  }
}

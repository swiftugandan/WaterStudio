/**
 * The app's handle on the engine: a small pool of workers, each with its own engine
 * instance, behind a promise-based API. Requests go to the least busy worker.
 *
 * A request can name a document (a `ModelSync`, such as core's `EngineSync`) instead of
 * a model. Each engine then holds the document's model between requests and receives
 * only what changed since its revision, or a snapshot the first time (ADR 0020).
 */

import type { AnyStudyResult, StudyRequest, StudyResult } from './study.ts';
import type { model, SessionRef } from '@waterstudio/core';
import {
  EngineError,
  STALE_SESSION,
  type ModelSource,
  type EngineReply,
  type EngineRequest,
  type EngineResponse,
  type EpanetFiles,
  type FilesRequest,
  type HydraulicReport,
  type MsxRequest,
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
  /** The document revision the engine will hold once its queued messages are handled. */
  session?: SessionRef | undefined;
}

/** A document an engine can hold between requests (core's `EngineSync`). */
export interface ModelSync {
  readonly epoch: number;
  readonly rev: number;
  snapshot(): model.Snapshot;
  /** What changed since `from`, or null if that is too far back. */
  patch(from: number): model.ModelPatch | null;
}

/** A model, or a document whose engines keep its model. */
export type Source = model.Model | ModelSync;

function isSync(s: Source): s is ModelSync {
  return typeof (s as Partial<ModelSync>).snapshot === 'function';
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
  study: AnyStudyResult;
  msx: RunResults;
  'session-open': null;
  'session-patch': null;
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
      slot.session = undefined;
      const err = new EngineError(event.message || 'engine worker failed');
      for (const p of slot.pending.values()) p.reject(err);
      slot.pending.clear();
    };
    return slot;
  }

  get size(): number {
    return this.slots.length;
  }

  /** The least busy worker, preferring one that already holds `want`. */
  private pick(want?: SessionRef): Slot {
    const holds = (s: Slot) =>
      want && s.session?.epoch === want.epoch && s.session.rev === want.rev ? 1 : 0;
    return this.slots.reduce((a, b) =>
      b.pending.size < a.pending.size || (b.pending.size === a.pending.size && holds(b) > holds(a)) ? b : a,
    );
  }

  private post(slot: Slot, body: Body): Promise<Timed<EngineReply>> {
    const id = this.nextId++;
    const req = { ...body, id };
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage(req);
    });
  }

  private async typed<K extends keyof Replies>(
    body: Body & { kind: K },
    slot = this.pick(),
  ): Promise<Timed<Replies[K]>> {
    const r = await this.post(slot, body);
    if (r.value.kind !== body.kind) throw new EngineError(`unexpected reply ${r.value.kind}`);
    return { value: r.value.value as Replies[K], ms: r.ms };
  }

  /**
   * Queue on a worker what it needs to hold the document at its current revision: a
   * patch from the revision it holds, or a snapshot. Messages are handled in order, so
   * a request posted next sees the result.
   */
  private bring(slot: Slot, sync: ModelSync): SessionRef {
    const want = { epoch: sync.epoch, rev: sync.rev };
    const have = slot.session;
    if (have?.epoch === want.epoch && have.rev === want.rev) return want;
    const patch = have?.epoch === want.epoch ? sync.patch(have.rev) : null;
    const sent = patch
      ? this.post(slot, { kind: 'session-patch', patch })
      : this.post(slot, { kind: 'session-open', snapshot: sync.snapshot() });
    slot.session = want;
    // If it fails, the request that follows fails as stale and is retried with a snapshot.
    sent.catch(() => {
      if (slot.session === want) slot.session = undefined;
    });
    return want;
  }

  /** A request on a model or on a document's resident model. */
  private async on<K extends keyof Replies>(
    source: Source,
    make: (m: ModelSource) => Body & { kind: K },
  ): Promise<Timed<Replies[K]>> {
    if (!isSync(source)) return this.typed<K>(make(source));
    for (let attempt = 0; ; attempt++) {
      const slot = this.pick({ epoch: source.epoch, rev: source.rev });
      const ref = this.bring(slot, source);
      try {
        return await this.typed<K>(make(ref), slot);
      } catch (e) {
        if (attempt > 0 || !(e instanceof EngineError) || !e.message.startsWith(STALE_SESSION)) throw e;
        // The engine lost the model (or a patch failed): it gets a snapshot next time.
        slot.session = undefined;
      }
    }
  }

  /** Read an EPANET .inp file into the canonical model, with any issues found. */
  readInp(inp: string): Promise<Timed<ReadResult>> {
    return this.typed({ kind: 'read-inp', inp });
  }

  /** Write the canonical model as .inp text. */
  writeInp(m: model.Model): Promise<Timed<string>> {
    return this.typed({ kind: 'write-inp', model: m });
  }

  /** Solve a model's (or a document's) hydraulics over its whole duration. */
  run(m: Source): Promise<Timed<RunResults>> {
    return this.on(m, (model) => ({ kind: 'run', model }));
  }

  /** Solve an .inp file, returning the parity harness's JSON report. */
  runHydraulicsInp(inp: string): Promise<Timed<HydraulicReport>> {
    return this.typed({ kind: 'run-hydraulics', inp });
  }

  /** Run a model as EPANET's runepanet does, for its report and output file. */
  runFiles(request: Omit<FilesRequest, 'model'> & { model: Source }): Promise<Timed<EpanetFiles>> {
    return this.on(request.model, (model) => ({ kind: 'run-files', request: { ...request, model } }));
  }

  /** Hydraulics and an EPANET-MSX analysis: the run's results with every species added. */
  msx(request: Omit<MsxRequest, 'model'> & { model: Source }): Promise<Timed<RunResults>> {
    return this.on(request.model, (model) => ({ kind: 'msx', request: { ...request, model } }));
  }

  /**
   * Run a study on one worker; split long lists across workers with several calls. With
   * a document, each worker receives the model once and the calls carry only options.
   */
  study<K extends StudyRequest['kind']>(request: {
    kind: K;
    model: Source;
    options: Extract<StudyRequest, { kind: K }>['options'];
  }): Promise<Timed<StudyResult<Extract<StudyRequest, { kind: K }>>>> {
    // The engine answers each kind with that kind's result.
    return this.on(request.model, (model) => ({
      kind: 'study',
      request: { ...request, model } as StudyRequest,
    })) as Promise<Timed<StudyResult<Extract<StudyRequest, { kind: K }>>>>;
  }

  /** The error EPANET would refuse the model with (bad controls or rules, say), or null. */
  check(m: Source): Promise<Timed<string | null>> {
    return this.on(m, (model) => ({ kind: 'check', model }));
  }

  dispose(): void {
    for (const s of this.slots) {
      s.worker.terminate();
      for (const p of s.pending.values()) p.reject(new EngineError('engine stopped'));
      s.pending.clear();
    }
  }
}

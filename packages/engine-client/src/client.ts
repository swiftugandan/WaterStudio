/**
 * The app's handle on the engine: a small pool of workers, each with its own engine
 * instance, behind a promise-based API. Requests go to the least busy worker.
 */

import { EngineError, type EngineRequest, type EngineResponse, type HydraulicReport } from './protocol.ts';

export interface RunResult {
  report: HydraulicReport;
  /** Time spent solving inside the worker, in milliseconds. */
  solveMs: number;
}

interface Slot {
  worker: Worker;
  pending: Map<number, { resolve: (r: RunResult) => void; reject: (e: Error) => void }>;
}

export type WorkerFactory = () => Worker;

const defaultFactory: WorkerFactory = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'ws-engine' });

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
      if (res.ok) p.resolve({ report: res.report, solveMs: res.solveMs });
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

  /** Solve the hydraulics of an EPANET .inp file over its whole duration. */
  runHydraulics(inp: string): Promise<RunResult> {
    const slot = this.slots.reduce((a, b) => (b.pending.size < a.pending.size ? b : a));
    const id = this.nextId++;
    const req: EngineRequest = { id, kind: 'run-hydraulics', inp };
    return new Promise((resolve, reject) => {
      slot.pending.set(id, { resolve, reject });
      slot.worker.postMessage(req);
    });
  }

  dispose(): void {
    for (const s of this.slots) {
      s.worker.terminate();
      for (const p of s.pending.values()) p.reject(new EngineError('engine stopped'));
      s.pending.clear();
    }
  }
}

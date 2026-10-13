/** What an engine worker does with each request (worker.ts; tests call it directly). */

import type { EngineReply, EngineRequest } from './protocol.ts';
import type { Engine } from './wasm.ts';

export function handle(e: Engine, req: EngineRequest): EngineReply {
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
    case 'session-open':
      e.sessionOpen(req.snapshot);
      return { kind: 'session-open', value: null };
    case 'session-patch':
      e.sessionPatch(req.patch);
      return { kind: 'session-patch', value: null };
  }
}

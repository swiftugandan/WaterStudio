/// <reference lib="webworker" />
/** The render worker: draws into a transferred OffscreenCanvas. */

import { createBackend, RenderCore, type FromRenderer, type Preference, type ToRenderer } from './core.ts';

declare const self: DedicatedWorkerGlobalScope;

type Init = { t: 'init'; canvas: OffscreenCanvas; prefer: Preference };

let core: RenderCore | null = null;
const queue: ToRenderer[] = [];
const emit = (m: FromRenderer) => self.postMessage(m);

self.onmessage = async (event: MessageEvent<Init | ToRenderer>) => {
  const m = event.data;
  if (m.t === 'init') {
    try {
      const { backend, note } = await createBackend(m.canvas, m.prefer);
      core = new RenderCore(backend, emit);
      emit(
        note === undefined
          ? { t: 'ready', backend: backend.name }
          : { t: 'ready', backend: backend.name, note },
      );
      for (const q of queue.splice(0)) core.handle(q);
    } catch (e) {
      emit({ t: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    return;
  }
  if (core) core.handle(m);
  else queue.push(m);
};

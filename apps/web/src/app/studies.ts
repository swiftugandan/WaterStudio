/**
 * Running studies across the engine pool: the list of hydrants or links is cut into
 * chunks that workers take as they free up, and the results are put back in order,
 * so the answer is the same as one worker's.
 */

import {
  EngineClient,
  type CriticalityOptions,
  type CriticalityResult,
  type FireFlowOptions,
  type FireFlowResult,
} from '@waterstudio/engine-client';
import type { model } from '@waterstudio/core';

let pool: EngineClient | null = null;

/** The study pool, started on first use (one engine per worker, up to eight, leaving a core free). */
export function studyPool(): EngineClient {
  if (!pool) {
    const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 2;
    pool = new EngineClient({ workers: Math.max(1, Math.min(8, (hw || 2) - 1)) });
  }
  return pool;
}

function chunks<T>(items: T[], parts: number): T[][] {
  const size = Math.max(1, Math.ceil(items.length / parts));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function runFireFlow(
  m: model.Model,
  options: FireFlowOptions,
  progress: (done: number, total: number) => void,
): Promise<FireFlowResult[]> {
  const engine = studyPool();
  const parts = chunks(options.hydrants, engine.size * 4);
  let done = 0;
  progress(0, options.hydrants.length);
  const results = await Promise.all(
    parts.map(async (hydrants) => {
      const r = await engine.study({ kind: 'fireFlow', model: m, options: { ...options, hydrants } });
      done += hydrants.length;
      progress(done, options.hydrants.length);
      return r.value;
    }),
  );
  return results.flat();
}

export async function runCriticality(
  m: model.Model,
  options: CriticalityOptions,
  progress: (done: number, total: number) => void,
): Promise<CriticalityResult[]> {
  const engine = studyPool();
  const links = options.links.length
    ? options.links
    : m.links.filter((l) => l.kind.type === 'pipe').map((l) => l.id);
  const parts = chunks(links, engine.size * 4);
  let done = 0;
  progress(0, links.length);
  const results = await Promise.all(
    parts.map(async (part) => {
      const r = await engine.study({ kind: 'criticality', model: m, options: { ...options, links: part } });
      done += part.length;
      progress(done, links.length);
      return r.value;
    }),
  );
  return results.flat();
}

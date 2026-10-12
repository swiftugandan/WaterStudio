/// <reference lib="webworker" />
/**
 * Reads and writes project files off the main thread with SQLite (WebAssembly).
 */

import init from '@sqlite.org/sqlite-wasm';
import { readProject, writeProject, type ProjectData, type ProjectMeta } from '@waterstudio/project';

export type ProjectRequest =
  | { id: number; op: 'write'; data: ProjectData; meta: ProjectMeta }
  | { id: number; op: 'read'; bytes: Uint8Array };

export type ProjectResponse =
  | { id: number; ok: true; bytes?: Uint8Array; project?: ProjectData & { meta: ProjectMeta } }
  | { id: number; ok: false; error: string };

declare const self: DedicatedWorkerGlobalScope;

const ready = init();

self.onmessage = async (e: MessageEvent<ProjectRequest>) => {
  const req = e.data;
  try {
    const sqlite3 = await ready;
    if (req.op === 'write') {
      const bytes = writeProject(sqlite3, req.data, req.meta);
      self.postMessage({ id: req.id, ok: true, bytes } satisfies ProjectResponse, [bytes.buffer]);
    } else {
      const project = readProject(sqlite3, req.bytes);
      self.postMessage({ id: req.id, ok: true, project } satisfies ProjectResponse);
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    self.postMessage({ id: req.id, ok: false, error } satisfies ProjectResponse);
  }
};

/**
 * Project files in the browser: a worker that reads and writes them, and an autosaved
 * copy in the origin-private file system for recovery after a crash or a closed tab.
 */

import type { ProjectData, ProjectMeta } from '@waterstudio/project';
import type { ProjectRequest, ProjectResponse } from './project.worker.ts';

type Pending = { resolve: (r: ProjectResponse & { ok: true }) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();

type Request = ProjectRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

function call(req: Request, transfer: Transferable[] = []): Promise<ProjectResponse & { ok: true }> {
  if (!worker) {
    worker = new Worker(new URL('./project.worker.ts', import.meta.url), {
      type: 'module',
      name: 'ws-project',
    });
    worker.onmessage = (e: MessageEvent<ProjectResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.ok) p.resolve(e.data);
      else p.reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      for (const p of pending.values()) p.reject(new Error(e.message || 'the project worker failed'));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  const id = nextId++;
  const w = worker;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    w.postMessage({ ...req, id }, transfer);
  });
}

export const APPLICATION = 'WaterStudio 0.1';

export async function encodeProject(data: ProjectData): Promise<Uint8Array> {
  const meta: ProjectMeta = { application: APPLICATION, saved: new Date().toISOString() };
  const r = await call({ op: 'write', data, meta });
  if (!r.bytes) throw new Error('the project worker returned nothing');
  return r.bytes;
}

export async function decodeProject(bytes: Uint8Array): Promise<ProjectData & { meta: ProjectMeta }> {
  const r = await call({ op: 'read', bytes }, [bytes.buffer]);
  if (!r.project) throw new Error('the project worker returned nothing');
  return r.project;
}

// ---- Autosave -------------------------------------------------------------------------

const AUTOSAVE_FILE = 'autosave.wsproj';
const AUTOSAVE_KEY = 'ws.autosave';

/** What is known about the autosaved copy without opening it. */
export interface AutosaveInfo {
  /** When it was written (ms since the epoch). */
  time: number;
  /** The network's file name. */
  name: string;
  /** False while it holds changes that were never saved to a file. */
  clean: boolean;
}

export function autosaveInfo(): AutosaveInfo | null {
  try {
    const v = JSON.parse(localStorage.getItem(AUTOSAVE_KEY) ?? 'null') as Partial<AutosaveInfo> | null;
    if (!v || typeof v.time !== 'number' || typeof v.name !== 'string') return null;
    return { time: v.time, name: v.name, clean: v.clean === true };
  } catch {
    return null;
  }
}

function setInfo(info: AutosaveInfo): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(info));
  } catch {
    // Storage may be unavailable (private windows); autosave is a convenience.
  }
}

/** Whether this session has written the autosaved copy (and so may vouch for it). */
let wrote = false;

/**
 * Record that this session's autosaved changes are safe elsewhere (saved to a file, or
 * discarded). A copy left by an earlier session stays recoverable.
 */
export function markAutosaveClean(): void {
  if (!wrote) return;
  const info = autosaveInfo();
  if (info && !info.clean) setInfo({ ...info, clean: true });
}

async function directory(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await navigator.storage.getDirectory();
  } catch {
    return null;
  }
}

/** Write the autosaved copy. False when the browser has no private file system. */
export async function writeAutosave(bytes: Uint8Array, name: string): Promise<boolean> {
  const dir = await directory();
  if (!dir) return false;
  try {
    const file = await dir.getFileHandle(AUTOSAVE_FILE, { create: true });
    const w = await file.createWritable();
    await w.write(bytes as Uint8Array<ArrayBuffer>);
    await w.close();
  } catch {
    return false;
  }
  wrote = true;
  setInfo({ time: Date.now(), name, clean: false });
  return true;
}

export async function readAutosave(): Promise<Uint8Array | null> {
  const dir = await directory();
  if (!dir) return null;
  try {
    const file = await (await dir.getFileHandle(AUTOSAVE_FILE)).getFile();
    return new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
}

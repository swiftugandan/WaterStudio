/**
 * Autosave: a few seconds after the network changes, the whole project is written to
 * the browser's private file system, so File › Recover can bring it back after a crash
 * or a closed tab.
 */

import { captureProject } from './project.ts';
import { autosaveInfo, encodeProject, writeAutosave } from './projectio.ts';
import type { AppState } from './state.ts';

/** Start autosaving; returns a function that stops it. */
export function startAutosave(s: AppState, delayMs = 4000): () => void {
  const key = () => `${s.generation}:${s.store.rev}`;
  let saved = key();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let failed = false;
  // Large networks take longer to capture; waiting ten times as long keeps it under ~10%.
  let interval = delayMs;

  const tick = async () => {
    timer = undefined;
    const k = key();
    if (k === saved) return;
    if (!s.dirty) {
      saved = k;
      return;
    }
    if (busy) {
      schedule();
      return;
    }
    busy = true;
    const t0 = performance.now();
    try {
      const ok = await writeAutosave(await encodeProject(captureProject(s)), s.fileName);
      interval = Math.max(delayMs, 10 * (performance.now() - t0));
      if (ok) saved = k;
      else if (!failed) {
        failed = true;
        s.log('warning', 'This browser cannot keep an autosaved copy: save the project to keep your work.');
      }
    } catch (e) {
      if (!failed) {
        failed = true;
        s.log('warning', `Autosave failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      busy = false;
    }
  };

  function schedule() {
    timer ??= setTimeout(() => void tick(), interval);
  }

  const unsubscribe = s.subscribe(() => {
    if (key() !== saved && s.dirty) schedule();
  });
  return () => {
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Tell the user about changes an earlier session left unsaved. */
export function noticeAutosave(s: AppState): void {
  const info = autosaveInfo();
  if (!info || info.clean) return;
  s.log(
    'warning',
    `Unsaved changes to ${info.name} from ${new Date(info.time).toLocaleString()} were autosaved. ` +
      'File › Recover brings them back; editing replaces that copy with this session’s.',
  );
}

/**
 * What of the app goes into a project file and how it comes back: the network with its
 * scenarios, isolation valves and MSX input, and how it was being viewed.
 */

import { toModel } from '@waterstudio/core';
import { storeScenarios, type ProjectData } from '@waterstudio/project';
import type { AppState, MapTheme } from './state.ts';

/** The view settings a project keeps. */
export interface ProjectSettings {
  mapTheme?: MapTheme;
  panels?: string[];
}

/** The app's project as it is now. */
export function captureProject(s: AppState): ProjectData {
  const doc = s.store.doc;
  const set = s.scenarios.toJSON();
  const settings: ProjectSettings = { mapTheme: s.mapTheme, panels: [...s.panels] };
  return {
    fileName: s.fileName,
    model: toModel(doc),
    scenarios: set.scenarios.length > 0 ? storeScenarios(doc, set) : null,
    isolationValves: doc.data.isolationValves,
    msx: doc.data.msx,
    settings: settings as Record<string, unknown>,
  };
}

/** The name a project is saved under: the project's own, or the network's with .wsproj. */
export function projectFileName(s: AppState): string {
  return s.projectName ?? `${s.fileName.replace(/\.[^./\\]*$/, '') || 'Untitled'}.wsproj`;
}

/** The view settings in a project, keeping only those this version understands. */
export function readSettings(settings: Record<string, unknown>): ProjectSettings {
  const out: ProjectSettings = {};
  const t = settings['mapTheme'];
  if (typeof t === 'object' && t !== null && 'ramp' in t) out.mapTheme = t as MapTheme;
  const p = settings['panels'];
  if (Array.isArray(p) && p.every((x) => typeof x === 'string')) out.panels = p;
  return out;
}

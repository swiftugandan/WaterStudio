/**
 * Every app action, registered on the command bus. The ribbon, shortcuts, the command
 * palette, context menus and (later) agents all execute these by id.
 */

import { CommandBus, deleteElements, toModel, type Command } from '@waterstudio/core';
import { LINK_VARIABLES, NODE_VARIABLES, linkFrame, nodeFrame } from '@waterstudio/engine-client';
import { dxfToModel, geoJSONToModel, modelToDxf, modelToGeoJSON } from '@waterstudio/gis';
import { resolveCrs } from '../geo/crs.ts';
import { backdropPlacement, crsText, modelCrs, withBackdropLine, withCrs } from '../geo/model.ts';
import { openFilePicker, saveTextFile } from './files.ts';
import type { AppState, Tool } from './state.ts';

const PANEL_ICONS: Record<string, string> = {
  report: 'file-text',
  assistant: 'sparkles',
  options: 'settings',
  patterns: 'chart-column',
  curves: 'spline',
  controls: 'list-checks',
};

export const SAMPLES = ['Net1', 'Net2', 'Net3'] as const;

type Cmd = Command<AppState>;

function tool(id: Tool, title: string, icon: string, shortcut: string, category = 'Draw'): Cmd {
  return {
    id: `tool.${id}`,
    title,
    icon,
    shortcut,
    category,
    checked: (s) => s.tool === id,
    run: (s) => s.setTool(id),
  };
}

async function guarded(s: AppState, what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    s.log('error', `${what}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function confirmDiscard(s: AppState): boolean {
  return !s.dirty || globalThis.confirm('Discard unsaved changes?');
}

export function createCommands(state: AppState): CommandBus<AppState> {
  const bus = new CommandBus(() => state);
  bus.register(
    {
      id: 'file.new',
      title: 'New network',
      icon: 'file-plus',
      shortcut: 'Mod+Alt+N',
      category: 'File',
      run: (s) => {
        if (confirmDiscard(s)) s.newModel();
      },
    },
    {
      id: 'file.open',
      title: 'Open .inp file…',
      icon: 'folder-open',
      shortcut: 'Mod+O',
      category: 'File',
      run: (s) =>
        guarded(s, 'Open failed', async () => {
          if (!confirmDiscard(s)) return;
          const file = await openFilePicker('.inp,.INP,text/plain');
          if (!file) return;
          await s.openInp(await file.text(), file.name);
          s.view?.fit();
        }),
    },
    ...SAMPLES.map((n): Cmd => ({
      id: `file.sample.${n}`,
      title: `Open sample ${n}`,
      icon: 'network',
      category: 'File',
      run: (s) =>
        guarded(s, `Could not open ${n}`, async () => {
          if (!confirmDiscard(s)) return;
          const res = await fetch(`/samples/${n}.inp`);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          await s.openInp(await res.text(), `${n}.inp`);
          s.view?.fit();
        }),
    })),
    {
      id: 'file.save',
      title: 'Save as .inp',
      icon: 'save',
      shortcut: 'Mod+S',
      category: 'File',
      run: (s) =>
        guarded(s, 'Save failed', async () => {
          const text = await s.saveInp();
          saveTextFile(text, s.fileName.endsWith('.inp') ? s.fileName : `${s.fileName}.inp`);
          s.log('info', `Saved ${s.fileName}.`);
        }),
    },
    {
      id: 'file.import.gis',
      title: 'Import GeoJSON or DXF…',
      icon: 'file-input',
      category: 'File',
      run: (s) =>
        guarded(s, 'Import failed', async () => {
          if (!confirmDiscard(s)) return;
          const file = await openFilePicker('.geojson,.json,.dxf,application/geo+json');
          if (!file) return;
          const text = await file.text();
          const { model, issues } = importGis(file.name, text);
          s.openModel(
            model,
            file.name.replace(/\.(geo)?json$|\.dxf$/i, '.inp'),
            issues.map((message) => ({ line: 0, section: 'IMPORT', severity: 'warning' as const, message })),
          );
          s.view?.fit();
        }),
    },
    {
      id: 'file.export.geojson',
      title: 'Export GeoJSON',
      icon: 'file-output',
      category: 'File',
      enabled: (s) => s.store.doc.nodes.liveCount > 0,
      run: (s) => {
        const crs = modelCrs(s.store.doc);
        const extra = resultAttributes(s);
        const fc = modelToGeoJSON(toModel(s.store.doc), {
          project: crs?.crs,
          ...(extra ? { extra } : {}),
        });
        saveTextFile(JSON.stringify(fc), `${baseName(s.fileName)}.geojson`);
        s.log(
          crs ? 'info' : 'warning',
          crs
            ? `Exported GeoJSON in longitude and latitude${extra ? ' with results at the current time' : ''}.`
            : 'Exported GeoJSON in the model’s own coordinates: set a coordinate system for standard GeoJSON.',
        );
      },
    },
    {
      id: 'file.export.dxf',
      title: 'Export DXF',
      icon: 'file-output',
      category: 'File',
      enabled: (s) => s.store.doc.nodes.liveCount > 0,
      run: (s) => {
        saveTextFile(modelToDxf(toModel(s.store.doc), { labels: true }), `${baseName(s.fileName)}.dxf`);
        s.log('info', 'Exported DXF (R12) with pipes, pumps, valves and nodes on their own layers.');
      },
    },
    {
      id: 'edit.undo',
      title: 'Undo',
      icon: 'undo',
      shortcut: 'Mod+Z',
      category: 'Edit',
      enabled: (s) => s.store.canUndo,
      run: (s) => s.store.undo(),
    },
    {
      id: 'edit.redo',
      title: 'Redo',
      icon: 'redo',
      shortcut: 'Mod+Shift+Z',
      category: 'Edit',
      enabled: (s) => s.store.canRedo,
      run: (s) => s.store.redo(),
    },
    {
      id: 'edit.delete',
      title: 'Delete selection',
      icon: 'trash',
      shortcut: 'Delete',
      category: 'Edit',
      enabled: (s) => s.selection.size > 0,
      run: (s) => {
        const n = deleteElements(s.store, s.selection);
        s.select([]);
        if (n > 0) s.log('info', `Deleted ${n} element${n === 1 ? '' : 's'}.`);
      },
    },
    {
      id: 'edit.selectAll',
      title: 'Select all',
      icon: 'select-all',
      shortcut: 'Mod+A',
      category: 'Edit',
      run: (s) => s.select([...s.store.doc.nodeHandles(), ...s.store.doc.linkHandles()]),
    },
    {
      id: 'edit.clearSelection',
      title: 'Clear selection',
      icon: 'x',
      shortcut: 'Escape',
      category: 'Edit',
      run: (s) => {
        s.select([]);
        s.setTool('select');
      },
    },
    tool('select', 'Select', 'pointer', 'V', 'Tools'),
    tool('pan', 'Pan', 'hand', 'H', 'Tools'),
    tool('junction', 'Add junction', 'junction', 'J'),
    tool('reservoir', 'Add reservoir', 'reservoir', 'R'),
    tool('tank', 'Add tank', 'tank', 'T'),
    tool('pipe', 'Add pipe', 'pipe', 'P'),
    tool('pump', 'Add pump', 'pump', 'U'),
    tool('valve', 'Add valve', 'valve', 'L'),
    {
      id: 'view.fit',
      title: 'Zoom to network',
      icon: 'fit',
      shortcut: 'F',
      category: 'View',
      run: (s) => s.view?.fit(),
    },
    {
      id: 'view.zoomIn',
      title: 'Zoom in',
      icon: 'zoom-in',
      shortcut: '=',
      category: 'View',
      run: (s) => s.view?.zoom(1.5),
    },
    {
      id: 'view.zoomOut',
      title: 'Zoom out',
      icon: 'zoom-out',
      shortcut: '-',
      category: 'View',
      run: (s) => s.view?.zoom(1 / 1.5),
    },
    {
      id: 'view.zoomSelection',
      title: 'Zoom to selection',
      icon: 'scan',
      shortcut: 'Shift+F',
      category: 'View',
      enabled: (s) => s.selection.size > 0,
      run: (s) => s.view?.zoomTo([...s.selection]),
    },
    {
      id: 'view.palette',
      title: 'Command palette',
      icon: 'command',
      shortcut: 'Mod+K',
      category: 'View',
      run: (s) => {
        s.paletteOpen = true;
        s.emit();
      },
    },
    ...(['light', 'dark', 'system'] as const).map((t): Cmd => ({
      id: `view.theme.${t}`,
      title: `Theme: ${t[0]!.toUpperCase()}${t.slice(1)}`,
      icon: t === 'dark' ? 'moon' : t === 'light' ? 'sun' : 'sun-moon',
      category: 'View',
      checked: (s) => s.prefs.theme === t,
      run: (s) => s.prefs.set({ theme: t }),
    })),
    ...(['comfortable', 'compact'] as const).map((d): Cmd => ({
      id: `view.density.${d}`,
      title: `Density: ${d[0]!.toUpperCase()}${d.slice(1)}`,
      icon: 'rows',
      category: 'View',
      checked: (s) => s.prefs.density === d,
      run: (s) => s.prefs.set({ density: d }),
    })),
    ...(['auto', 'webgpu', 'canvas2d'] as const).map((r): Cmd => ({
      id: `view.renderer.${r}`,
      title: `Renderer: ${r === 'auto' ? 'Automatic' : r === 'webgpu' ? 'WebGPU' : 'Canvas 2D'}`,
      icon: 'monitor',
      category: 'View',
      checked: (s) => s.prefs.renderer === r,
      run: (s) => s.prefs.set({ renderer: r }),
    })),
    ...(
      [
        ['browser', 'Model browser'],
        ['properties', 'Properties'],
        ['results', 'Results table'],
        ['messages', 'Messages'],
        ['report', 'Reports'],
        ['assistant', 'Assistant'],
        ['options', 'Options'],
        ['patterns', 'Patterns'],
        ['curves', 'Curves'],
        ['controls', 'Controls'],
      ] as const
    ).map(([id, title]): Cmd => ({
      id: `view.panel.${id}`,
      title: `Show ${title.toLowerCase()}`,
      icon: PANEL_ICONS[id] ?? 'panel',
      category: 'View',
      checked: (s) => s.panels.has(id),
      run: (s) => {
        const next = new Set(s.panels);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        s.panels = next;
        s.emit();
      },
    })),
    {
      id: 'view.basemap',
      title: 'Street map under the network',
      icon: 'map',
      category: 'View',
      checked: (s) => s.prefs.basemap === 'on',
      run: (s) => s.prefs.set({ basemap: s.prefs.basemap === 'on' ? 'off' : 'on' }),
    },
    {
      id: 'map.crs',
      title: 'Set coordinate system…',
      icon: 'globe',
      category: 'Map',
      run: (s) => {
        const doc = s.store.doc;
        const current = crsText(doc.data.backdrop) ?? '';
        const answer = globalThis.prompt(
          'Coordinate system of the network: an EPSG code (e.g. EPSG:32633 for UTM 33N, EPSG:27700, ' +
            'EPSG:4326) or a proj4 definition. Leave empty for none.',
          current,
        );
        if (answer === null) return;
        const text = answer.trim();
        if (text && !resolveCrs(text)) {
          s.log(
            'error',
            `Unknown coordinate system "${text}". Use an EPSG code listed in the help, or proj4.`,
          );
          return;
        }
        if (text === current) return;
        s.store.transact('Set coordinate system', (tx) =>
          tx.setDoc('backdrop', withCrs(doc.data.backdrop, text || null)),
        );
        s.log(
          'info',
          text ? `Coordinate system set to ${resolveCrs(text)!.label}.` : 'Coordinate system removed.',
        );
      },
    },
    {
      id: 'map.backdrop',
      title: 'Load backdrop image…',
      icon: 'image',
      category: 'Map',
      run: (s) =>
        guarded(s, 'Backdrop failed', async () => {
          const file = await openFilePicker('image/*');
          if (!file) return;
          const doc = s.store.doc;
          let backdrop = withBackdropLine(doc.data.backdrop, 'FILE', [file.name]);
          // Without DIMENSIONS, stretch the image over the network, as EPANET does.
          if (!backdropPlacement(backdrop)) {
            const b = networkBounds(s);
            if (b)
              backdrop = withBackdropLine(
                backdrop,
                'DIMENSIONS',
                b.map((v) => String(v)),
              );
          }
          s.store.transact('Load backdrop', (tx) => tx.setDoc('backdrop', backdrop));
          if (s.backdrop) URL.revokeObjectURL(s.backdrop.url);
          s.backdrop = { url: URL.createObjectURL(file), name: file.name };
          s.log(
            'info',
            `Backdrop ${file.name} shown; its position is saved in [BACKDROP], the image is not.`,
          );
          s.emit();
        }),
    },
    {
      id: 'map.backdrop.hide',
      title: 'Remove backdrop image',
      icon: 'image-off',
      category: 'Map',
      enabled: (s) => s.backdrop !== null,
      run: (s) => {
        if (s.backdrop) URL.revokeObjectURL(s.backdrop.url);
        s.backdrop = null;
        s.emit();
      },
    },
    {
      id: 'analysis.run',
      title: 'Run hydraulics',
      icon: 'run-hydraulics',
      shortcut: 'F5',
      category: 'Analysis',
      enabled: (s) => s.run.status !== 'running' && s.store.doc.nodes.liveCount > 0,
      run: (s) => s.runHydraulics(),
    },
    {
      id: 'graph.series',
      title: 'Time series graph of selection',
      icon: 'chart-line',
      category: 'Results',
      enabled: (s) => s.run.status === 'done' && s.selection.size > 0,
      run: (s) => {
        const doc = s.store.doc;
        const sel = [...s.selection].filter((h) => doc.has(h));
        const nodes = sel.filter((h) => doc.isNode(h));
        if (nodes.length > 0) {
          const variable = s.mapTheme.node ?? 'pressure';
          s.openGraph({ kind: 'series', table: 'node', variable, ids: nodes.map((h) => doc.id(h)) });
        } else {
          const variable = s.mapTheme.link ?? 'flow';
          s.openGraph({ kind: 'series', table: 'link', variable, ids: sel.map((h) => doc.id(h)) });
        }
      },
    },
    {
      id: 'graph.profile',
      title: 'Profile along selected nodes',
      icon: 'mountain',
      category: 'Results',
      enabled: (s) =>
        s.run.status === 'done' && [...s.selection].filter((h) => s.store.doc.isNode(h)).length >= 2,
      run: (s) => {
        const doc = s.store.doc;
        const ids = [...s.selection].filter((h) => doc.has(h) && doc.isNode(h)).map((h) => doc.id(h));
        s.openGraph({ kind: 'profile', variable: 'head', ids });
      },
    },
    {
      id: 'graph.frequency',
      title: 'Frequency distribution',
      icon: 'chart-column',
      category: 'Results',
      enabled: (s) => s.run.status === 'done',
      run: (s) => s.openGraph({ kind: 'frequency', table: 'node', variable: s.mapTheme.node ?? 'pressure' }),
    },
    {
      id: 'graph.flow',
      title: 'System flow graph',
      icon: 'arrow-left-right',
      category: 'Results',
      enabled: (s) => s.run.status === 'done',
      run: (s) => s.openGraph({ kind: 'flow' }),
    },
    {
      id: 'graph.contour',
      title: 'Contour plot',
      icon: 'layers',
      category: 'Results',
      enabled: (s) => s.run.status === 'done',
      run: (s) => s.openGraph({ kind: 'contour', variable: s.mapTheme.node ?? 'pressure' }),
    },
    {
      id: 'results.prev',
      title: 'Previous report time',
      icon: 'step-back',
      shortcut: 'Alt+ArrowLeft',
      category: 'Results',
      enabled: (s) => s.run.results !== undefined && s.period > 0,
      run: (s) => s.setPeriod(s.period - 1),
    },
    {
      id: 'results.next',
      title: 'Next report time',
      icon: 'step-forward',
      shortcut: 'Alt+ArrowRight',
      category: 'Results',
      enabled: (s) => s.run.results !== undefined && s.period < s.run.results.times.length - 1,
      run: (s) => s.setPeriod(s.period + 1),
    },
  );
  return bus;
}

/** The network's bounding box as [minX, minY, maxX, maxY], or null if it has no nodes. */
function networkBounds(s: AppState): [number, number, number, number] | null {
  const doc = s.store.doc;
  let b: [number, number, number, number] | null = null;
  for (const h of doc.nodeHandles()) {
    const x = doc.num(h, 'x');
    const y = doc.num(h, 'y');
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    b = b ? [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)] : [x, y, x, y];
  }
  return b;
}

function baseName(name: string): string {
  return name.replace(/\.inp$/i, '');
}

/** The UTM zone (as an EPSG code) containing a longitude and latitude. */
export function utmZone(lng: number, lat: number): string {
  const zone = Math.min(60, Math.max(1, Math.floor((lng + 180) / 6) + 1));
  return `EPSG:${lat >= 0 ? 326 : 327}${String(zone).padStart(2, '0')}`;
}

/**
 * Read a GeoJSON or DXF file into a model. GeoJSON in longitude and latitude is put
 * into the UTM zone of its centre, so lengths come out in metres.
 */
export function importGis(name: string, text: string): ReturnType<typeof dxfToModel> {
  if (/\.dxf$/i.test(name)) {
    const r = dxfToModel(text, { snap: snapFor(extentOf(text)), units: 'LPS' });
    return {
      model: r.model,
      issues: [...r.issues, 'DXF has no coordinate system; set one to see a street map.'],
    };
  }
  const data: unknown = JSON.parse(text);
  const pts: [number, number][] = [];
  collectPositions(data, pts);
  const geographic = pts.length > 0 && pts.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
  if (!geographic) {
    const r = geoJSONToModel(data, { snap: snapFor(pts), units: 'LPS' });
    return {
      model: r.model,
      issues: [...r.issues, 'The coordinates are not longitude and latitude; no coordinate system was set.'],
    };
  }
  const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
  const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const code = utmZone(cx, cy);
  const crs = resolveCrs(code)!;
  const r = geoJSONToModel(data, { project: crs, snap: 0.5, units: 'LPS' });
  r.model.backdrop = withCrs(r.model.backdrop, code);
  return { model: r.model, issues: [...r.issues, `Coordinates were projected to ${crs.label} (${code}).`] };
}

function collectPositions(v: unknown, out: [number, number][]): void {
  if (Array.isArray(v)) {
    if (v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number') out.push([v[0], v[1]]);
    else for (const x of v) collectPositions(x, out);
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v))
      if (k === 'coordinates' || k === 'features' || k === 'geometry') collectPositions(x, out);
  }
}

/** Rough coordinates of a DXF drawing, for a snap tolerance. */
function extentOf(dxf: string): [number, number][] {
  const lines = dxf.split(/\r?\n/);
  const out: [number, number][] = [];
  for (let i = 0; i + 3 < lines.length; i += 2) {
    if (lines[i]!.trim() === '10' && lines[i + 2]!.trim() === '20')
      out.push([Number(lines[i + 1]), Number(lines[i + 3])]);
  }
  return out;
}

/** A snap tolerance of a millionth of the data's extent, at least a millimetre. */
function snapFor(pts: [number, number][]): number {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const span = Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 1;
  return Math.max(span * 1e-6, 1e-3);
}

/** Results at the current report time, by element ID, when they are up to date. */
function resultAttributes(
  s: AppState,
): ((table: 'node' | 'link', id: string) => Record<string, number>) | undefined {
  const r = s.run;
  if (r.status !== 'done' || !r.results || !r.nodes || !r.links || s.stale) return undefined;
  const doc = s.store.doc;
  const p = Math.min(s.period, r.results.times.length - 1);
  const nodes = new Map<string, Record<string, number>>();
  const links = new Map<string, Record<string, number>>();
  r.nodes.forEach((h, i) => {
    if (!doc.has(h)) return;
    const rec: Record<string, number> = {};
    for (const v of NODE_VARIABLES) rec[`result_${v}`] = nodeFrame(r.results!, v, p)[i]!;
    nodes.set(doc.id(h), rec);
  });
  r.links.forEach((h, i) => {
    if (!doc.has(h)) return;
    const rec: Record<string, number> = {};
    for (const v of LINK_VARIABLES) rec[`result_${v}`] = linkFrame(r.results!, v, p)[i]!;
    links.set(doc.id(h), rec);
  });
  return (table, id) => (table === 'node' ? nodes.get(id) : links.get(id)) ?? {};
}

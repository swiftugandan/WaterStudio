/**
 * Every app action, registered on the command bus. The ribbon, shortcuts, the command
 * palette, context menus and (later) agents all execute these by id.
 */

import {
  applyScenario,
  CommandBus,
  deleteElements,
  reverseLinks,
  scenarioText,
  toModel,
  type Command,
} from '@waterstudio/core';
import { LINK_VARIABLES, NODE_VARIABLES, linkFrame, nodeFrame } from '@waterstudio/engine-client';
import { modelToDxf, modelToGeoJSON, modelToShapefiles, writeZip } from '@waterstudio/gis';
import { importGis, importShapefiles, shapefileFiles } from './gisio.ts';
import { resolveCrs } from '../geo/crs.ts';
import { backdropPlacement, crsText, modelCrs, withBackdropLine, withCrs } from '../geo/model.ts';
import { openFilePicker, openFilesPicker, saveBinaryFile, saveBlob, saveTextFile } from './files.ts';
import { svgToPng } from '../viewport/svg.ts';
import type { AppState, Tool } from './state.ts';

const PANEL_ICONS: Record<string, string> = {
  report: 'file-text',
  assistant: 'sparkles',
  options: 'settings',
  patterns: 'chart-column',
  curves: 'spline',
  controls: 'list-checks',
  query: 'filter',
  add: 'plus',
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
      title: 'Import GeoJSON, shapefile or DXF…',
      icon: 'file-input',
      category: 'File',
      run: (s) =>
        guarded(s, 'Import failed', async () => {
          if (!confirmDiscard(s)) return;
          const files = await openFilesPicker(
            '.geojson,.json,.dxf,.zip,.shp,.dbf,.prj,.cpg,.shx,application/geo+json',
          );
          const file = files[0];
          if (!file) return;
          const shape = files.some((f) => /\.(zip|shp)$/i.test(f.name));
          const { model, issues } = shape
            ? importShapefiles(
                await shapefileFiles(
                  await Promise.all(
                    files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) })),
                  ),
                ),
              )
            : importGis(file.name, await file.text());
          const main = files.find((f) => /\.(zip|shp)$/i.test(f.name)) ?? file;
          s.openModel(
            model,
            main.name.replace(/\.(geo)?json$|\.dxf$|\.zip$|\.shp$/i, '.inp'),
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
      id: 'file.export.shapefile',
      title: 'Export shapefiles',
      icon: 'file-output',
      category: 'File',
      enabled: (s) => s.store.doc.nodes.liveCount > 0,
      run: (s) => {
        const crs = modelCrs(s.store.doc);
        const extra = resultAttributes(s);
        const base = baseName(s.fileName);
        const files = modelToShapefiles(toModel(s.store.doc), base, {
          project: crs?.crs,
          ...(extra ? { extra } : {}),
        });
        saveBinaryFile(writeZip(files), `${base}_shp.zip`);
        s.log(
          crs ? 'info' : 'warning',
          crs
            ? 'Exported node and link shapefiles in longitude and latitude (WGS 84).'
            : 'Exported shapefiles in the model’s own coordinates, without a .prj: set a coordinate system for standard ones.',
        );
      },
    },
    {
      id: 'file.export.scenario',
      title: 'Export scenario',
      icon: 'file-output',
      category: 'File',
      enabled: (s) => s.store.doc.nodes.liveCount > 0,
      run: (s) => {
        const base = baseName(s.fileName);
        saveTextFile(scenarioText(s.store.doc, base), `${base}.scn`);
        s.log('info', 'Exported demands, initial quality, pipe diameters and roughness, controls and rules.');
      },
    },
    {
      id: 'file.import.scenario',
      title: 'Import scenario…',
      icon: 'file-input',
      category: 'File',
      enabled: (s) => s.store.doc.nodes.liveCount > 0,
      run: (s) =>
        guarded(s, 'Scenario import failed', async () => {
          const file = await openFilePicker('.scn,.txt,.inp');
          if (!file) return;
          const r = applyScenario(s.store, await file.text());
          const what = Object.entries(r.applied)
            .map(([k, n]) => `${n} ${k.toLowerCase()}`)
            .join(', ');
          s.log('info', `Applied scenario ${file.name}: ${what}.`);
          for (const i of r.issues) s.log('warning', i);
        }),
    },
    {
      id: 'file.export.svg',
      title: 'Export map as SVG',
      icon: 'image',
      category: 'File',
      enabled: (s) => s.view !== null && s.store.doc.nodes.liveCount > 0,
      run: (s) => {
        const m = s.view?.exportSvg();
        if (!m) return;
        saveBlob(new Blob([m.svg], { type: 'image/svg+xml' }), `${baseName(s.fileName)}.svg`);
      },
    },
    {
      id: 'file.export.png',
      title: 'Export map as PNG',
      icon: 'image',
      category: 'File',
      enabled: (s) => s.view !== null && s.store.doc.nodes.liveCount > 0,
      run: (s) =>
        guarded(s, 'Map export failed', async () => {
          const m = s.view?.exportSvg();
          if (!m) return;
          saveBlob(await svgToPng(m.svg, m.width, m.height), `${baseName(s.fileName)}.png`);
        }),
    },
    {
      id: 'file.print',
      title: 'Print map',
      icon: 'printer',
      category: 'File',
      enabled: (s) => s.view !== null,
      run: (s) => {
        const m = s.view?.exportSvg();
        if (!m) return;
        const w = window.open('', '_blank');
        if (!w) {
          s.log(
            'warning',
            'The print window was blocked; allow pop-ups for this site, or export the map as SVG.',
          );
          return;
        }
        w.document.title = s.fileName;
        w.document.body.style.margin = '0';
        const img = w.document.createElement('img');
        img.src = URL.createObjectURL(new Blob([m.svg], { type: 'image/svg+xml' }));
        img.style.width = '100%';
        img.alt = `Map of ${s.fileName}`;
        img.onload = () => w.print();
        w.document.body.append(img);
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
      id: 'edit.reverse',
      title: 'Reverse link direction',
      icon: 'arrow-left-right',
      category: 'Edit',
      enabled: (s) => [...s.selection].some((h) => s.store.doc.has(h) && s.store.doc.isLink(h)),
      run: (s) => {
        const n = reverseLinks(s.store, s.selection);
        s.log('info', `Reversed ${n} link${n === 1 ? '' : 's'}.`);
      },
    },
    {
      id: 'edit.autoLength',
      title: 'Auto-length',
      icon: 'ruler',
      category: 'Edit',
      checked: (s) => s.prefs.autoLength === 'on',
      run: (s) => s.prefs.setAutoLength(s.prefs.autoLength !== 'on'),
    },
    {
      id: 'edit.find',
      title: 'Find node or link',
      icon: 'search',
      shortcut: 'Mod+F',
      category: 'Edit',
      run: (s) => {
        s.findRequest++;
        s.showPanel('query');
      },
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
    tool('label', 'Add or edit map label', 'type', 'B'),
    ...(
      [
        ['nodeIds', 'Show node IDs'],
        ['nodeValues', 'Show node values'],
        ['linkIds', 'Show link IDs'],
        ['linkValues', 'Show link values'],
        ['flowArrows', 'Show flow arrows'],
        ['mapLabels', 'Show map labels'],
      ] as const
    ).map(([key, title]): Cmd => ({
      id: `view.map.${key}`,
      title,
      icon: key === 'flowArrows' ? 'arrow-right' : 'type',
      category: 'View',
      checked: (s) => s.prefs.map[key],
      run: (s) => s.prefs.setMap({ [key]: !s.prefs.map[key] }),
    })),
    {
      id: 'view.map.larger',
      title: 'Larger nodes and links',
      icon: 'zoom-in',
      category: 'View',
      enabled: (s) => s.prefs.map.size < 5,
      run: (s) => s.prefs.setMap({ size: s.prefs.map.size + 1 }),
    },
    {
      id: 'view.map.smaller',
      title: 'Smaller nodes and links',
      icon: 'zoom-out',
      category: 'View',
      enabled: (s) => s.prefs.map.size > 1,
      run: (s) => s.prefs.setMap({ size: s.prefs.map.size - 1 }),
    },
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
        ['query', 'Query and group edit'],
        ['add', 'Add element'],
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

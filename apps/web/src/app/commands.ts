/**
 * Every app action, registered on the command bus. The ribbon, shortcuts, the command
 * palette, context menus and (later) agents all execute these by id.
 */

import { CommandBus, deleteElements, type Command } from '@waterstudio/core';
import { openFilePicker, saveTextFile } from './files.ts';
import type { AppState, Tool } from './state.ts';

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
      ] as const
    ).map(([id, title]): Cmd => ({
      id: `view.panel.${id}`,
      title: `Show ${title.toLowerCase()}`,
      icon: id === 'report' ? 'file-text' : 'panel',
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

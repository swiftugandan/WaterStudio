/**
 * The docking workspace (dockview): the map in the centre, the browser on the left,
 * properties on the right, results and messages below. Every panel but the map can be
 * closed, moved, floated or reopened from the View tab; the layout is remembered.
 */

import {
  DockviewDefaultTab,
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useEffect, useRef } from 'react';
import { useApp, useAppContext } from '../app/context.tsx';
import { BrowserPanel } from '../panels/BrowserPanel.tsx';
import { MessagesPanel } from '../panels/MessagesPanel.tsx';
import { PropertiesPanel } from '../panels/PropertiesPanel.tsx';
import { ResultsPanel } from '../panels/ResultsPanel.tsx';
import { MapView } from '../viewport/MapView.tsx';

const LAYOUT_KEY = 'ws.layout.v1';

const PANELS: Record<
  string,
  { title: string; position: () => Parameters<DockviewApi['addPanel']>[0]['position'] }
> = {
  browser: { title: 'Model', position: () => ({ referencePanel: 'map', direction: 'left' }) },
  properties: { title: 'Properties', position: () => ({ referencePanel: 'map', direction: 'right' }) },
  results: { title: 'Results', position: () => ({ referencePanel: 'map', direction: 'below' }) },
  messages: { title: 'Messages', position: () => ({ referencePanel: 'results', direction: 'within' }) },
};

const components = {
  map: () => <MapView />,
  browser: () => <BrowserPanel />,
  properties: () => <PropertiesPanel />,
  results: () => <ResultsPanel />,
  messages: () => <MessagesPanel />,
};

const tabComponents = {
  fixed: (props: IDockviewPanelHeaderProps) => <DockviewDefaultTab {...props} hideClose />,
};

function addPanel(api: DockviewApi, id: string): void {
  if (api.getPanel(id)) return;
  const spec = PANELS[id];
  if (!spec) return;
  let position = spec.position();
  if (position && 'referencePanel' in position && !api.getPanel(position.referencePanel as string)) {
    position = { referencePanel: 'map', direction: 'below' };
  }
  api.addPanel({
    id,
    component: id,
    title: spec.title,
    ...(position ? { position } : {}),
    ...(id === 'browser' ? { initialWidth: 260 } : id === 'properties' ? { initialWidth: 320 } : {}),
    ...(id === 'results' ? { initialHeight: 220 } : {}),
    inactive: true,
  });
}

function defaultLayout(api: DockviewApi, open: Set<string>): void {
  api.clear();
  api.addPanel({ id: 'map', component: 'map', title: 'Map', tabComponent: 'fixed' });
  for (const id of ['browser', 'properties', 'results', 'messages']) if (open.has(id)) addPanel(api, id);
  api.getPanel('map')?.api.setActive();
}

export function Dock() {
  const { state } = useAppContext();
  const { version } = useApp();
  const api = useRef<DockviewApi | null>(null);
  const syncing = useRef(false);

  const onReady = (e: DockviewReadyEvent) => {
    api.current = e.api;
    let restored = false;
    try {
      const saved = localStorage.getItem(LAYOUT_KEY);
      if (saved) {
        e.api.fromJSON(JSON.parse(saved) as Parameters<DockviewApi['fromJSON']>[0]);
        restored = e.api.getPanel('map') !== undefined;
      }
    } catch {
      restored = false;
    }
    if (!restored) defaultLayout(e.api, state.panels);
    state.panels = new Set(e.api.panels.map((p) => p.id).filter((id) => id !== 'map'));
    state.emit();
    e.api.onDidRemovePanel((p) => {
      if (syncing.current) return;
      const next = new Set(state.panels);
      next.delete(p.id);
      state.panels = next;
      state.emit();
    });
    e.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(e.api.toJSON()));
      } catch {
        // Layout persistence is a convenience.
      }
    });
  };

  // Reflect panel toggles from commands.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    syncing.current = true;
    for (const id of Object.keys(PANELS)) {
      const has = a.getPanel(id);
      if (state.panels.has(id) && !has) addPanel(a, id);
      if (!state.panels.has(id) && has) has.api.close();
    }
    syncing.current = false;
  }, [version, state]);

  return (
    <DockviewReact
      className="ws-dock dockview-theme-light"
      components={components}
      tabComponents={tabComponents}
      onReady={onReady}
    />
  );
}

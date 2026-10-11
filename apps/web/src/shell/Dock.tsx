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
  type IDockviewPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';
import { useEffect, useRef } from 'react';
import { useApp, useAppContext } from '../app/context.tsx';
import { AssistantPanel } from '../panels/AssistantPanel.tsx';
import { AddPanel } from '../panels/AddPanel.tsx';
import { BrowserPanel } from '../panels/BrowserPanel.tsx';
import { ControlsPanel } from '../panels/ControlsPanel.tsx';
import { CurvesPanel, PatternsPanel } from '../panels/DataPanel.tsx';
import { OptionsPanel } from '../panels/OptionsPanel.tsx';
import { QueryPanel } from '../panels/QueryPanel.tsx';
import { GraphPanel, graphTitle, type GraphParams } from '../panels/GraphPanel.tsx';
import { ReportPanel } from '../panels/ReportPanel.tsx';
import { MessagesPanel } from '../panels/MessagesPanel.tsx';
import { PropertiesPanel } from '../panels/PropertiesPanel.tsx';
import { ResultsPanel } from '../panels/ResultsPanel.tsx';
import { MapView } from '../viewport/MapView.tsx';

const LAYOUT_KEY = 'ws.layout.v1';
const DATA_EDITORS = new Set(['patterns', 'curves', 'controls']);

const PANELS: Record<
  string,
  { title: string; position: () => Parameters<DockviewApi['addPanel']>[0]['position'] }
> = {
  browser: { title: 'Model', position: () => ({ referencePanel: 'map', direction: 'left' }) },
  properties: { title: 'Properties', position: () => ({ referencePanel: 'map', direction: 'right' }) },
  results: { title: 'Results', position: () => ({ referencePanel: 'map', direction: 'below' }) },
  messages: { title: 'Messages', position: () => ({ referencePanel: 'results', direction: 'within' }) },
  report: { title: 'Reports', position: () => ({ referencePanel: 'results', direction: 'within' }) },
  assistant: { title: 'Assistant', position: () => ({ referencePanel: 'properties', direction: 'within' }) },
  options: { title: 'Options', position: () => ({ referencePanel: 'properties', direction: 'within' }) },
  patterns: { title: 'Patterns', position: () => ({ referencePanel: 'map', direction: 'right' }) },
  curves: { title: 'Curves', position: () => ({ referencePanel: 'map', direction: 'right' }) },
  controls: { title: 'Controls', position: () => ({ referencePanel: 'map', direction: 'right' }) },
  query: { title: 'Query', position: () => ({ referencePanel: 'properties', direction: 'within' }) },
  add: { title: 'Add element', position: () => ({ referencePanel: 'properties', direction: 'within' }) },
};

const components = {
  map: () => <MapView />,
  browser: () => <BrowserPanel />,
  properties: () => <PropertiesPanel />,
  results: () => <ResultsPanel />,
  messages: () => <MessagesPanel />,
  report: () => <ReportPanel />,
  assistant: () => <AssistantPanel />,
  options: () => <OptionsPanel />,
  patterns: () => <PatternsPanel />,
  curves: () => <CurvesPanel />,
  controls: () => <ControlsPanel />,
  query: () => <QueryPanel />,
  add: () => <AddPanel />,
  graph: (props: IDockviewPanelProps<GraphParams>) => <GraphPanel {...props} />,
};

const tabComponents = {
  fixed: (props: IDockviewPanelHeaderProps) => <DockviewDefaultTab {...props} hideClose />,
};

function addPanel(api: DockviewApi, id: string): void {
  if (api.getPanel(id)) return;
  const spec = PANELS[id];
  if (!spec) return;
  let position = spec.position();
  // The data editors share one group beside the map, with the graphs if any are open.
  if (DATA_EDITORS.has(id)) {
    const sibling = api.panels.find((p) => DATA_EDITORS.has(p.id) || p.id.startsWith('graph-'));
    if (sibling) position = { referencePanel: sibling.id, direction: 'within' };
  }
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
    ...(DATA_EDITORS.has(id) ? { initialWidth: 520 } : {}),
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

  // Reflect panel toggles from commands, and open requested graphs.
  useEffect(() => {
    const a = api.current;
    if (!a) return;
    for (const spec of state.takeGraphRequests()) {
      let n = 1;
      while (a.getPanel(`graph-${n}`)) n++;
      // New graphs join an open graph's group as tabs, or split the map.
      const sibling = a.panels.find((p) => p.id.startsWith('graph-'));
      a.addPanel({
        id: `graph-${n}`,
        component: 'graph',
        title: graphTitle(spec),
        params: { spec },
        position: sibling
          ? { referencePanel: sibling.id, direction: 'within' }
          : { referencePanel: 'map', direction: 'right' },
        initialWidth: 460,
      });
    }
    syncing.current = true;
    for (const id of Object.keys(PANELS)) {
      const has = a.getPanel(id);
      if (state.panels.has(id) && !has) {
        addPanel(a, id);
        a.getPanel(id)?.api.setActive();
      }
      if (!state.panels.has(id) && has) has.api.close();
    }
    syncing.current = false;
    const focus = state.takePanelFocus();
    if (focus) a.getPanel(focus)?.api.setActive();
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

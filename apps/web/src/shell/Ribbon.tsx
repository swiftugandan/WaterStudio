/**
 * The ribbon: tabs of command groups. Every button runs a command from the bus, so it
 * shows the same title, icon, shortcut and enabled or checked state everywhere.
 */

import {
  isSpecies,
  linkVariables,
  nodeVariables,
  type LinkVar,
  type NodeVar,
} from '@waterstudio/engine-client';
import { useState, type ReactNode } from 'react';
import { useApp } from '../app/context.tsx';
import { shortcutLabel } from '../app/shortcuts.ts';
import { Icon } from './Icon.tsx';
import { TimeControl } from './TimeControl.tsx';

type Item = { cmd: string; size?: 'large' | 'small'; label?: string } | { custom: 'mapTheme' | 'time' };
interface Group {
  label: string;
  items: Item[];
}
interface Tab {
  id: string;
  label: string;
  groups: Group[];
}

const TABS: Tab[] = [
  {
    id: 'home',
    label: 'Home',
    groups: [
      {
        label: 'File',
        items: [
          { cmd: 'file.open', size: 'large', label: 'Open' },
          { cmd: 'file.save', size: 'large', label: 'Save' },
          { cmd: 'file.new', label: 'New' },
          { cmd: 'file.print', label: 'Print' },
          { cmd: 'file.sample.Net1', label: 'Net1' },
          { cmd: 'file.sample.Net2', label: 'Net2' },
          { cmd: 'file.sample.Net3', label: 'Net3' },
        ],
      },
      {
        label: 'Import and export',
        items: [
          { cmd: 'file.import.gis', label: 'Import GIS' },
          { cmd: 'file.import.scenario', label: 'Scenario in' },
          { cmd: 'file.export.geojson', label: 'GeoJSON' },
          { cmd: 'file.export.shapefile', label: 'Shapefile' },
          { cmd: 'file.export.dxf', label: 'DXF' },
          { cmd: 'file.export.scenario', label: 'Scenario out' },
          { cmd: 'file.export.svg', label: 'Map SVG' },
          { cmd: 'file.export.png', label: 'Map PNG' },
        ],
      },
      {
        label: 'Edit',
        items: [
          { cmd: 'edit.undo', size: 'large' },
          { cmd: 'edit.redo', size: 'large' },
          { cmd: 'edit.delete', label: 'Delete' },
          { cmd: 'edit.selectAll' },
          { cmd: 'edit.copyProps', label: 'Copy' },
          { cmd: 'edit.pasteProps', label: 'Paste' },
        ],
      },
      {
        label: 'Select',
        items: [
          { cmd: 'edit.find', size: 'large', label: 'Find' },
          { cmd: 'view.panel.query', size: 'large', label: 'Query' },
        ],
      },
      {
        label: 'Tools',
        items: [
          { cmd: 'tool.select', size: 'large' },
          { cmd: 'tool.pan', size: 'large' },
        ],
      },
      {
        label: 'View',
        items: [
          { cmd: 'view.fit', size: 'large', label: 'Fit' },
          { cmd: 'view.zoomIn' },
          { cmd: 'view.zoomOut' },
        ],
      },
      { label: 'Analysis', items: [{ cmd: 'analysis.run', size: 'large', label: 'Run' }] },
    ],
  },
  {
    id: 'draw',
    label: 'Draw',
    groups: [
      {
        label: 'Tools',
        items: [
          { cmd: 'tool.select', size: 'large' },
          { cmd: 'tool.pan', size: 'large' },
        ],
      },
      {
        label: 'Nodes',
        items: [
          { cmd: 'tool.junction', size: 'large', label: 'Junction' },
          { cmd: 'tool.reservoir', size: 'large', label: 'Reservoir' },
          { cmd: 'tool.tank', size: 'large', label: 'Tank' },
        ],
      },
      {
        label: 'Links',
        items: [
          { cmd: 'tool.pipe', size: 'large', label: 'Pipe' },
          { cmd: 'tool.pump', size: 'large', label: 'Pump' },
          { cmd: 'tool.valve', size: 'large', label: 'Valve' },
        ],
      },
      { label: 'Keyboard', items: [{ cmd: 'view.panel.add', size: 'large', label: 'Add element' }] },
      {
        label: 'Annotate',
        items: [
          { cmd: 'tool.label', size: 'large', label: 'Label' },
          { cmd: 'tool.isovalve', size: 'large', label: 'Isolation valve' },
        ],
      },
      {
        label: 'Edit',
        items: [
          { cmd: 'edit.delete', size: 'large', label: 'Delete' },
          { cmd: 'edit.reverse', label: 'Reverse' },
          { cmd: 'edit.autoLength', label: 'Auto-length' },
        ],
      },
    ],
  },
  {
    id: 'project',
    label: 'Project',
    groups: [
      { label: 'Settings', items: [{ cmd: 'view.panel.options', size: 'large', label: 'Options' }] },
      { label: 'Scenarios', items: [{ cmd: 'view.panel.scenarios', size: 'large', label: 'Scenarios' }] },
      {
        label: 'Data',
        items: [
          { cmd: 'view.panel.patterns', size: 'large', label: 'Patterns' },
          { cmd: 'view.panel.curves', size: 'large', label: 'Curves' },
          { cmd: 'view.panel.controls', size: 'large', label: 'Controls' },
        ],
      },
      {
        label: 'Tools',
        items: [
          { cmd: 'tools.elevations', size: 'large', label: 'Elevations' },
          { cmd: 'tools.demands', size: 'large', label: 'Demands' },
        ],
      },
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    groups: [
      { label: 'Setup', items: [{ cmd: 'view.panel.options', size: 'large', label: 'Options' }] },
      {
        label: 'Run',
        items: [
          { cmd: 'analysis.run', size: 'large', label: 'Run hydraulics' },
          { cmd: 'analysis.msx', size: 'large', label: 'Run MSX' },
          { cmd: 'view.panel.msx', label: 'Multi-species' },
        ],
      },
      {
        label: 'Studies',
        items: [{ cmd: 'view.panel.studies', size: 'large', label: 'Fire flow, criticality' }],
      },
      { label: 'AI', items: [{ cmd: 'view.panel.assistant', size: 'large', label: 'Assistant' }] },
    ],
  },
  {
    id: 'results',
    label: 'Results',
    groups: [
      {
        label: 'Map',
        items: [{ custom: 'mapTheme' }, { cmd: 'view.panel.legend', size: 'large', label: 'Legend' }],
      },
      { label: 'Time', items: [{ custom: 'time' }] },
      {
        label: 'Graphs',
        items: [
          { cmd: 'graph.series', size: 'large', label: 'Time series' },
          { cmd: 'graph.profile', size: 'large', label: 'Profile' },
          { cmd: 'graph.frequency', size: 'large', label: 'Frequency' },
          { cmd: 'graph.flow', size: 'large', label: 'System flow' },
          { cmd: 'graph.contour', size: 'large', label: 'Contour' },
        ],
      },
      {
        label: 'Reports',
        items: [
          { cmd: 'view.panel.report', size: 'large', label: 'Reports' },
          { cmd: 'view.panel.formats', size: 'large', label: 'Formats' },
        ],
      },
    ],
  },
  {
    id: 'view',
    label: 'View',
    groups: [
      {
        label: 'Panels',
        items: [
          { cmd: 'view.panel.browser', label: 'Browser' },
          { cmd: 'view.panel.properties', label: 'Properties' },
          { cmd: 'view.panel.results', label: 'Results' },
          { cmd: 'view.panel.messages', label: 'Messages' },
          { cmd: 'view.panel.report', label: 'Reports' },
          { cmd: 'view.panel.assistant', label: 'Assistant' },
          { cmd: 'view.panel.options', label: 'Options' },
          { cmd: 'view.panel.patterns', label: 'Patterns' },
          { cmd: 'view.panel.curves', label: 'Curves' },
          { cmd: 'view.panel.controls', label: 'Controls' },
        ],
      },
      {
        label: 'Annotations',
        items: [
          { cmd: 'view.map.nodeIds', label: 'Node IDs' },
          { cmd: 'view.map.nodeValues', label: 'Node values' },
          { cmd: 'view.map.linkIds', label: 'Link IDs' },
          { cmd: 'view.map.linkValues', label: 'Link values' },
          { cmd: 'view.map.flowArrows', label: 'Flow arrows' },
          { cmd: 'view.map.mapLabels', label: 'Labels' },
          { cmd: 'view.map.overview', label: 'Overview' },
          { cmd: 'view.map.larger', label: 'Larger' },
          { cmd: 'view.map.smaller', label: 'Smaller' },
        ],
      },
      {
        label: 'Theme',
        items: [
          { cmd: 'view.theme.light', label: 'Light' },
          { cmd: 'view.theme.dark', label: 'Dark' },
          { cmd: 'view.theme.system', label: 'System' },
        ],
      },
      {
        label: 'Density',
        items: [
          { cmd: 'view.density.comfortable', label: 'Comfortable' },
          { cmd: 'view.density.compact', label: 'Compact' },
          { cmd: 'view.singleKeys', label: 'Single-key shortcuts' },
        ],
      },
      {
        label: 'Renderer',
        items: [
          { cmd: 'view.renderer.auto', label: 'Automatic' },
          { cmd: 'view.renderer.webgpu', label: 'WebGPU' },
          { cmd: 'view.renderer.canvas2d', label: 'Canvas 2D' },
        ],
      },
      {
        label: 'Map',
        items: [
          { cmd: 'view.basemap', size: 'large', label: 'Street map' },
          { cmd: 'map.crs', size: 'large', label: 'Coordinates' },
          { cmd: 'map.backdrop', label: 'Backdrop' },
          { cmd: 'tool.backdrop', label: 'Align backdrop' },
          { cmd: 'map.backdrop.hide', label: 'No backdrop' },
        ],
      },
      { label: 'Find', items: [{ cmd: 'view.palette', size: 'large', label: 'Commands' }] },
    ],
  },
];

function CommandButton({
  cmd,
  size = 'small',
  label,
}: {
  cmd: string;
  size?: 'large' | 'small';
  label?: string;
}) {
  const { bus } = useApp();
  const c = bus.get(cmd);
  if (!c) return null;
  const enabled = bus.isEnabled(cmd);
  const checked = c.checked ? bus.isChecked(cmd) : undefined;
  const text = label ?? c.title;
  const tip = c.shortcut ? `${c.title} (${shortcutLabel(c.shortcut)})` : c.title;
  return (
    <button
      type="button"
      className={`rb-btn ${size}`}
      disabled={!enabled}
      aria-pressed={checked}
      title={tip}
      aria-label={text === c.title ? undefined : c.title}
      onClick={() => bus.execute(cmd)}
    >
      <Icon name={c.icon} size={size === 'large' ? 24 : 16} />
      <span>{text}</span>
    </button>
  );
}

const VAR_LABEL: Record<string, string> = {
  demand: 'Demand',
  head: 'Head',
  pressure: 'Pressure',
  deficit: 'Demand deficit',
  emitter: 'Emitter flow',
  leakage: 'Leakage',
  flow: 'Flow',
  velocity: 'Velocity',
  headloss: 'Unit head loss',
  status: 'Status',
  setting: 'Setting',
  quality: 'Quality',
  reaction: 'Reaction rate',
  friction: 'Friction factor',
};

function MapTheme() {
  const { state } = useApp();
  const t = state.mapTheme;
  return (
    <div className="rb-fields">
      <label>
        <span>Nodes</span>
        <select
          value={t.node ?? ''}
          onChange={(e) => state.setMapTheme({ node: (e.target.value || null) as NodeVar | null })}
        >
          <option value="">None</option>
          {nodeVariables(state.run.results).map((v) => (
            <option key={v} value={v}>
              {variableLabel(v)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Links</span>
        <select
          value={t.link ?? ''}
          onChange={(e) => state.setMapTheme({ link: (e.target.value || null) as LinkVar | null })}
        >
          <option value="">None</option>
          {linkVariables(state.run.results).map((v) => (
            <option key={v} value={v}>
              {variableLabel(v)}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Colours</span>
        <select value={t.ramp} onChange={(e) => state.setMapTheme({ ramp: e.target.value as typeof t.ramp })}>
          <option value="viridis">Viridis</option>
          <option value="cividis">Cividis</option>
          <option value="epanet">EPANET classic</option>
        </select>
      </label>
    </div>
  );
}

/** A variable's name inside a sentence: lower case, but a species keeps its ID's case. */
export function variableNoun(v: string): string {
  return isSpecies(v) ? v.slice(4) : variableLabel(v).toLowerCase();
}

/** A result variable's name; a species is named by its ID. */
export function variableLabel(v: string): string {
  if (isSpecies(v)) return v.slice(4);
  return VAR_LABEL[v] ?? v;
}

export function Ribbon() {
  const [tab, setTab] = useState('home');
  const [collapsed, setCollapsed] = useState(false);
  const active = TABS.find((t) => t.id === tab) ?? TABS[0]!;
  const render = (it: Item, k: number): ReactNode => {
    if ('cmd' in it) return <CommandButton key={k} {...it} />;
    return it.custom === 'mapTheme' ? <MapTheme key={k} /> : <TimeControl key={k} />;
  };
  return (
    <div className={`ribbon${collapsed ? ' collapsed' : ''}`}>
      <div className="rb-tabs" role="tablist" aria-label="Ribbon">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`rb-tab-${t.id}`}
            aria-selected={t.id === tab}
            aria-controls="rb-panel"
            onClick={() => {
              setTab(t.id);
              setCollapsed(false);
            }}
            onDoubleClick={() => setCollapsed((c) => !c)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!collapsed && (
        <div className="rb-panel" id="rb-panel" role="tabpanel" aria-labelledby={`rb-tab-${active.id}`}>
          {active.groups.map((g) => (
            <section className="rb-group" key={g.label} aria-label={g.label}>
              <div className="rb-items">{g.items.map(render)}</div>
              <div className="rb-label">{g.label}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

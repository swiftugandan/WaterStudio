/**
 * The ribbon: tabs of command groups. Every button runs a command from the bus, so it
 * shows the same title, icon, shortcut and enabled or checked state everywhere.
 */

import {
  LINK_VARIABLES,
  NODE_VARIABLES,
  type LinkVariable,
  type NodeVariable,
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
          { cmd: 'file.import.gis', label: 'Import GIS/DXF' },
          { cmd: 'file.export.geojson', label: 'GeoJSON' },
          { cmd: 'file.export.dxf', label: 'DXF' },
          { cmd: 'file.sample.Net1', label: 'Net1' },
          { cmd: 'file.sample.Net2', label: 'Net2' },
          { cmd: 'file.sample.Net3', label: 'Net3' },
        ],
      },
      {
        label: 'Edit',
        items: [
          { cmd: 'edit.undo', size: 'large' },
          { cmd: 'edit.redo', size: 'large' },
          { cmd: 'edit.delete', label: 'Delete' },
          { cmd: 'edit.selectAll' },
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
      { label: 'Edit', items: [{ cmd: 'edit.delete', size: 'large', label: 'Delete' }] },
    ],
  },
  {
    id: 'project',
    label: 'Project',
    groups: [
      { label: 'Settings', items: [{ cmd: 'view.panel.options', size: 'large', label: 'Options' }] },
      {
        label: 'Data',
        items: [
          { cmd: 'view.panel.patterns', size: 'large', label: 'Patterns' },
          { cmd: 'view.panel.curves', size: 'large', label: 'Curves' },
          { cmd: 'view.panel.controls', size: 'large', label: 'Controls' },
        ],
      },
    ],
  },
  {
    id: 'analysis',
    label: 'Analysis',
    groups: [
      { label: 'Setup', items: [{ cmd: 'view.panel.options', size: 'large', label: 'Options' }] },
      { label: 'Run', items: [{ cmd: 'analysis.run', size: 'large', label: 'Run hydraulics' }] },
      { label: 'AI', items: [{ cmd: 'view.panel.assistant', size: 'large', label: 'Assistant' }] },
    ],
  },
  {
    id: 'results',
    label: 'Results',
    groups: [
      { label: 'Map', items: [{ custom: 'mapTheme' }] },
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
      { label: 'Reports', items: [{ cmd: 'view.panel.report', size: 'large', label: 'Reports' }] },
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
          onChange={(e) => state.setMapTheme({ node: (e.target.value || null) as NodeVariable | null })}
        >
          <option value="">None</option>
          {NODE_VARIABLES.map((v) => (
            <option key={v} value={v}>
              {VAR_LABEL[v]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Links</span>
        <select
          value={t.link ?? ''}
          onChange={(e) => state.setMapTheme({ link: (e.target.value || null) as LinkVariable | null })}
        >
          <option value="">None</option>
          {LINK_VARIABLES.map((v) => (
            <option key={v} value={v}>
              {VAR_LABEL[v]}
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

export function variableLabel(v: string): string {
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

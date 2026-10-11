/**
 * One graph, as EPANET draws them: a time series of chosen elements, a profile along a
 * path, a frequency distribution, or the system flow balance. The graph's definition
 * lives in its panel's parameters, so the layout remembers it. A table view shows the
 * same numbers for screen readers and copying.
 */

import {
  LINK_VARIABLES,
  NODE_VARIABLES,
  type LinkVariable,
  type NodeVariable,
} from '@waterstudio/engine-client';
import type { IDockviewPanelProps } from 'dockview-react';
import { useState } from 'react';
import { useApp } from '../app/context.tsx';
import {
  frequencySeries,
  profileSeries,
  systemFlow,
  timeSeries,
  type GraphSpec,
  type RunIndex,
} from '../app/graphs.ts';
import { LineChart, type Series } from '../charts/LineChart.tsx';
import { hoursLabel, tickLabel } from '../charts/scale.ts';
import { variableLabel } from '../shell/Ribbon.tsx';
import { clock } from '../shell/TimeControl.tsx';
import { variableUnit } from '../viewport/paint.ts';

export interface GraphParams {
  spec: GraphSpec;
}

export function graphTitle(spec: GraphSpec): string {
  switch (spec.kind) {
    case 'series':
      return `${variableLabel(spec.variable)}: ${spec.ids.slice(0, 3).join(', ')}${spec.ids.length > 3 ? '…' : ''}`;
    case 'profile':
      return `${variableLabel(spec.variable)} profile`;
    case 'frequency':
      return `${variableLabel(spec.variable)} distribution`;
    case 'flow':
      return 'System flow';
  }
}

export function GraphPanel(props: IDockviewPanelProps<GraphParams>) {
  const { state } = useApp();
  const [table, setTable] = useState(false);
  const spec = props.params.spec;
  const setSpec = (next: GraphSpec) => {
    props.api.updateParameters({ spec: next });
    props.api.setTitle(graphTitle(next));
  };
  const r = state.run;
  const doc = state.store.doc;
  const u = state.units;

  const variablePicker = (table: 'node' | 'link', value: string, onChange: (v: string) => void) => (
    <label>
      <span>Variable</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {(table === 'node' ? NODE_VARIABLES : LINK_VARIABLES).map((v) => (
          <option key={v} value={v}>
            {variableLabel(v)}
          </option>
        ))}
      </select>
    </label>
  );

  let picker = null;
  if (spec.kind === 'series' || spec.kind === 'frequency') {
    picker = variablePicker(spec.table, spec.variable, (v) =>
      setSpec(
        spec.table === 'node'
          ? { ...spec, table: 'node', variable: v as NodeVariable }
          : { ...spec, table: 'link', variable: v as LinkVariable },
      ),
    );
  } else if (spec.kind === 'profile') {
    picker = variablePicker('node', spec.variable, (v) => setSpec({ ...spec, variable: v as NodeVariable }));
  }

  const addSelection =
    spec.kind === 'series' || spec.kind === 'profile'
      ? () => {
          const table = spec.kind === 'profile' ? 'node' : spec.table;
          const ids = [...state.selection]
            .filter((h) => doc.has(h) && (table === 'node' ? doc.isNode(h) : doc.isLink(h)))
            .map((h) => doc.id(h))
            .filter((id) => !spec.ids.includes(id));
          if (ids.length > 0) setSpec({ ...spec, ids: [...spec.ids, ...ids] });
        }
      : null;

  let body;
  if (r.status !== 'done' || !r.results || !r.nodes || !r.links) {
    body = <p className="panel-empty">Run the analysis to see this graph.</p>;
  } else {
    const run: RunIndex = { results: r.results, nodes: r.nodes, links: r.links };
    const period = Math.min(state.period, r.results.times.length - 1);
    const at = clock(r.results.reportStart + period * r.results.reportStep);
    const nowHours = (r.results.reportStart + period * r.results.reportStep) / 3600;
    let series: Series[] = [];
    let title = graphTitle(spec);
    let xLabel = 'Time (hours)';
    let yLabel = '';
    let xFormat: ((x: number) => string) | undefined = hoursLabel;
    let marker: number | undefined;
    let step = false;
    switch (spec.kind) {
      case 'series':
        series = timeSeries(doc, run, spec);
        yLabel = withUnit(variableLabel(spec.variable), variableUnit(spec.variable, u));
        marker = nowHours;
        step = true;
        break;
      case 'profile': {
        const prof = profileSeries(doc, run, spec, period);
        series = prof?.series ?? [];
        title = `${variableLabel(spec.variable)} profile at ${at}`;
        xLabel = withUnit('Distance', u.si ? 'm' : 'ft');
        yLabel = withUnit(variableLabel(spec.variable), variableUnit(spec.variable, u));
        xFormat = undefined;
        series = series.map((s) => ({
          ...s,
          name: s.name === 'elevation' ? 'Elevation' : variableLabel(s.name),
        }));
        break;
      }
      case 'frequency':
        series = frequencySeries(run, spec, period, doc);
        title = `Distribution of ${variableLabel(spec.variable).toLowerCase()} at ${at}`;
        xLabel = withUnit(variableLabel(spec.variable), variableUnit(spec.variable, u));
        yLabel = 'Percent less than or equal';
        xFormat = (x) => tickLabel(x, 0.01);
        break;
      case 'flow':
        series = systemFlow(doc, run);
        yLabel = withUnit('Flow', variableUnit('flow', u));
        marker = nowHours;
        step = true;
        break;
    }
    body =
      series.length === 0 ? (
        <p className="panel-empty">
          {spec.kind === 'profile'
            ? 'No path joins these nodes. Select two or more connected nodes and add them.'
            : 'None of these elements exist any more. Select some and add them.'}
        </p>
      ) : (
        <LineChart
          title={title}
          series={series}
          xLabel={xLabel}
          yLabel={yLabel}
          {...(xFormat ? { xFormat } : {})}
          {...(xFormat === hoursLabel ? { xTickFormat: hoursLabel } : {})}
          {...(marker !== undefined ? { marker } : {})}
          step={step}
          table={table}
        />
      );
  }

  return (
    <div className="panel graph">
      <div className="panel-toolbar">
        {picker}
        {addSelection && (
          <button type="button" className="btn" onClick={addSelection} disabled={state.selection.size === 0}>
            Add selection
          </button>
        )}
        <button type="button" className="btn" aria-pressed={table} onClick={() => setTable((t) => !t)}>
          Table
        </button>
      </div>
      {body}
    </div>
  );
}

function withUnit(label: string, unit: string): string {
  return unit ? `${label} (${unit})` : label;
}

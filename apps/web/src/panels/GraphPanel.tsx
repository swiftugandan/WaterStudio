/**
 * One graph, as EPANET draws them: a time series of chosen elements, a profile along a
 * path, a frequency distribution, or the system flow balance. The graph's definition
 * lives in its panel's parameters, so the layout remembers it. A table view shows the
 * same numbers for screen readers and copying.
 */

import {
  LINK_VARIABLES,
  NODE_VARIABLES,
  nodeFrame,
  type LinkVariable,
  type NodeVariable,
} from '@waterstudio/engine-client';
import type { IDockviewPanelProps } from 'dockview-react';
import { useMemo, useState } from 'react';
import { copyText, tsv } from '../app/files.ts';
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
import { themeLegend, variableUnit } from '../viewport/paint.ts';
import { ContourPlot } from '../charts/ContourPlot.tsx';
import type { AppState } from '../app/state.ts';

/** EPANET's graph options: a title, axis limits and grid lines. */
export interface GraphOptions {
  title?: string;
  xMin?: number;
  xMax?: number;
  yMin?: number;
  yMax?: number;
  grid?: boolean;
}

export interface GraphParams {
  spec: GraphSpec;
  options?: GraphOptions;
}

function OptionsForm({ options, onChange }: { options: GraphOptions; onChange: (o: GraphOptions) => void }) {
  const num = (key: 'xMin' | 'xMax' | 'yMin' | 'yMax', label: string) => (
    <label>
      <span>{label}</span>
      <input
        type="text"
        inputMode="decimal"
        placeholder="Auto"
        defaultValue={options[key] === undefined ? '' : String(options[key])}
        onBlur={(e) => {
          const t = e.target.value.trim();
          const v = t === '' ? undefined : Number(t);
          if (v !== undefined && !Number.isFinite(v)) {
            e.target.setCustomValidity('Enter a number, or leave it empty for automatic.');
            e.target.reportValidity();
            return;
          }
          e.target.setCustomValidity('');
          const next: GraphOptions = Object.fromEntries(Object.entries(options).filter(([k]) => k !== key));
          if (v !== undefined) next[key] = v;
          onChange(next);
        }}
      />
    </label>
  );
  return (
    <div className="graph-options" role="group" aria-label="Graph options">
      <label className="wide">
        <span>Title</span>
        <input
          type="text"
          placeholder="Automatic"
          defaultValue={options.title ?? ''}
          onBlur={(e) => {
            const t = e.target.value.trim();
            const next = { ...options };
            if (t) next.title = t;
            else delete next.title;
            onChange(next);
          }}
        />
      </label>
      {num('xMin', 'X from')}
      {num('xMax', 'X to')}
      {num('yMin', 'Y from')}
      {num('yMax', 'Y to')}
      <label className="check">
        <input
          type="checkbox"
          checked={options.grid !== false}
          onChange={(e) => onChange({ ...options, grid: e.target.checked })}
        />
        <span>Grid lines</span>
      </label>
    </div>
  );
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
    case 'contour':
      return `${variableLabel(spec.variable)} contours`;
  }
}

export function GraphPanel(props: IDockviewPanelProps<GraphParams>) {
  const { state } = useApp();
  const [table, setTable] = useState(false);
  const spec = props.params.spec;
  const options = props.params.options ?? {};
  const [showOptions, setShowOptions] = useState(false);
  const setSpec = (next: GraphSpec) => {
    props.api.updateParameters({ spec: next, options });
    props.api.setTitle(graphTitle(next));
  };
  const setOptions = (next: GraphOptions) => props.api.updateParameters({ spec, options: next });
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
  } else if (spec.kind === 'profile' || spec.kind === 'contour') {
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
  let copyRows: (string | number)[][] | null = null;
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
    if (spec.kind === 'contour') {
      return (
        <div className="panel graph">
          <div className="panel-toolbar">
            {picker}
            <button type="button" className="btn" aria-pressed={table} onClick={() => setTable((t) => !t)}>
              Table
            </button>
          </div>
          <Contour state={state} run={run} variable={spec.variable} period={period} at={at} table={table} />
        </div>
      );
    }
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
    copyRows = series.length ? seriesRows(series, xLabel, yLabel) : null;
    body =
      series.length === 0 ? (
        <p className="panel-empty">
          {spec.kind === 'profile'
            ? 'No path joins these nodes. Select two or more connected nodes and add them.'
            : 'None of these elements exist any more. Select some and add them.'}
        </p>
      ) : (
        <LineChart
          title={options.title ?? title}
          range={options}
          grid={options.grid !== false}
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

  const copy = () => {
    if (!copyRows) return;
    const rows = copyRows;
    void copyText(tsv(rows)).then((ok) =>
      state.log(
        ok ? 'info' : 'warning',
        ok ? `Copied ${rows.length - 1} rows.` : 'The browser did not allow copying.',
      ),
    );
  };

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
        <button type="button" className="btn" disabled={copyRows === null} onClick={copy}>
          Copy
        </button>
        <button
          type="button"
          className="btn"
          aria-expanded={showOptions}
          onClick={() => setShowOptions((v) => !v)}
        >
          Options
        </button>
      </div>
      {showOptions && <OptionsForm options={options} onChange={setOptions} />}
      {body}
    </div>
  );
}

function Contour({
  state,
  run,
  variable,
  period,
  at,
  table,
}: {
  state: AppState;
  run: RunIndex;
  variable: NodeVariable;
  period: number;
  at: string;
  table: boolean;
}) {
  const doc = state.store.doc;
  const data = useMemo(() => {
    const frame = nodeFrame(run.results, variable, period);
    const xs: number[] = [];
    const ys: number[] = [];
    const vs: number[] = [];
    run.nodes.forEach((h, col) => {
      if (!doc.has(h)) return;
      const x = doc.num(h, 'x');
      const y = doc.num(h, 'y');
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      xs.push(x);
      ys.push(y);
      vs.push(frame[col]!);
    });
    const links: number[][] = [];
    for (const l of doc.linkHandles()) {
      const a = doc.get(l, 'from') as number;
      const b = doc.get(l, 'to') as number;
      links.push([
        doc.num(a, 'x'),
        doc.num(a, 'y'),
        ...(doc.get(l, 'vertices') as number[]),
        doc.num(b, 'x'),
        doc.num(b, 'y'),
      ]);
    }
    return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), values: Float64Array.from(vs), links };
    // The run's results change with the document's revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, variable, period, doc, state.store.rev]);
  const legend = themeLegend(run.results, 'node', variable, state.mapTheme);
  if (data.xs.length < 3)
    return <p className="panel-empty">A contour plot needs three or more nodes with coordinates.</p>;
  return (
    <ContourPlot
      title={`${variableLabel(variable)} at ${at}`}
      unit={variableUnit(variable, state.units)}
      {...data}
      breaks={legend.breaks}
      colors={legend.colors}
      table={table}
    />
  );
}

function withUnit(label: string, unit: string): string {
  return unit ? `${label} (${unit})` : label;
}

/** A graph's series as rows: one x column when the series share their x values, else an x and y pair each. */
function seriesRows(series: Series[], xLabel: string, yLabel: string): (string | number)[][] {
  const shared = series.every(
    (s) => s.x.length === series[0]!.x.length && Array.from(s.x).every((x, i) => x === series[0]!.x[i]),
  );
  if (shared) {
    const head = [xLabel, ...series.map((s) => s.name)];
    return [head, ...Array.from(series[0]!.x, (x, i) => [x, ...series.map((s) => s.y[i] ?? '')])];
  }
  const head = series.flatMap((s) => [`${s.name}: ${xLabel}`, `${s.name}: ${yLabel}`]);
  const n = Math.max(...series.map((s) => s.x.length));
  return [head, ...Array.from({ length: n }, (_, i) => series.flatMap((s) => [s.x[i] ?? '', s.y[i] ?? '']))];
}

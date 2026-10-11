/**
 * The legend editor, as EPANET's: the intervals the map colours nodes and links by,
 * set by hand, as equal intervals over the results' range, or automatically (rounded
 * quantiles). Intervals belong to a variable, so switching the map's variable and back
 * keeps them.
 */

import { getfloat } from '@waterstudio/core';
import { linkColumn, nodeColumn, type LinkVar, type NodeVar } from '@waterstudio/engine-client';
import { rampColors } from '@waterstudio/render';
import { useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';
import { variableNoun } from '../shell/Ribbon.tsx';
import { legendOf, themeLegend, variableUnit } from '../viewport/paint.ts';

function nice(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return 0;
  const p = 10 ** Math.floor(Math.log10(Math.abs(x)) - 1);
  return Math.round(x / p) * p;
}

function Editor({ state, table }: { state: AppState; table: 'node' | 'link' }) {
  const r = state.run;
  const v = table === 'node' ? state.mapTheme.node : state.mapTheme.link;
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  if (!v) return <p className="muted">No {table} variable is shown on the map.</p>;
  if (r.status !== 'done' || !r.results) return <p className="muted">Run the analysis to set intervals.</p>;
  const results = r.results;
  const key = `${table}:${v}`;
  const custom = state.mapTheme.breaks?.[key];
  const legend = themeLegend(results, table, v, state.mapTheme);
  const unit = variableUnit(v, state.units, results);
  const set = (breaks: number[] | null) => {
    const all = { ...(state.mapTheme.breaks ?? {}) };
    const next = Object.fromEntries(Object.entries(all).filter(([k]) => k !== key));
    if (breaks) next[key] = breaks;
    state.setMapTheme({ breaks: next });
  };
  const col = table === 'node' ? nodeColumn(results, v as NodeVar) : linkColumn(results, v as LinkVar);
  const values = Array.from(col, (x) => (v === 'flow' ? Math.abs(x) : x)).filter(Number.isFinite);
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const colors = rampColors(state.mapTheme.ramp, legend.breaks.length + 1);
  return (
    <section className="field-group" aria-labelledby={`${id}-h`}>
      <h3 id={`${id}-h`}>
        {table === 'node' ? 'Nodes' : 'Links'}: {variableNoun(v)}
        {unit ? ` (${unit})` : ''} {custom ? '· set by hand' : '· automatic'}
      </h3>
      <ol className="legend-edit">
        {colors.map((c, k) => (
          <li key={k}>
            <span className="chip" style={{ background: c }} aria-hidden="true" />
            {k < legend.breaks.length ? (
              <input
                type="text"
                inputMode="decimal"
                aria-label={`Upper limit of interval ${k + 1}`}
                defaultValue={String(legend.breaks[k])}
                key={`${key}:${k}:${legend.breaks[k]}`}
                onBlur={(e) => {
                  const x = getfloat(e.target.value.trim());
                  if (x === undefined) {
                    setError('Each limit must be a number.');
                    return;
                  }
                  const next = [...legend.breaks];
                  next[k] = x;
                  if (next.some((b, i) => i > 0 && b <= next[i - 1]!)) {
                    setError('Limits must increase from one interval to the next.');
                    return;
                  }
                  setError(null);
                  set(next);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
              />
            ) : (
              <span className="muted">and above</span>
            )}
          </li>
        ))}
      </ol>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="btn"
          onClick={() => {
            const n = Math.max(1, legend.breaks.length);
            const step = (hi - lo) / (n + 1);
            const b = Array.from({ length: n }, (_, i) => nice(lo + step * (i + 1)));
            set(b.filter((x, i) => i === 0 || x > b[i - 1]!));
          }}
          disabled={!(hi > lo)}
        >
          Equal intervals
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => set([...legend.breaks, nice(hi)].filter((x, i, a) => i === 0 || x > a[i - 1]!))}
          disabled={legend.breaks.length >= 8}
        >
          Add interval
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => set(legend.breaks.slice(0, -1))}
          disabled={legend.breaks.length <= 1}
        >
          Remove interval
        </button>
        <button type="button" className="btn" onClick={() => set(null)} disabled={!custom}>
          Automatic
        </button>
      </div>
      <p className="muted">
        Results range from {Number(lo.toPrecision(4))} to {Number(hi.toPrecision(4))} over the simulation.
        {custom
          ? ''
          : ` Automatic limits: ${legendOf(results, table, v, state.mapTheme.ramp).breaks.join(', ')}.`}
      </p>
    </section>
  );
}

export function LegendPanel() {
  const { state } = useApp();
  return (
    <div className="panel legend-panel">
      <Editor state={state} table="node" />
      <Editor state={state} table="link" />
    </div>
  );
}

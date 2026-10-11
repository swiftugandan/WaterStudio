/**
 * Pattern and curve editors. A list of the data objects with add, rename and delete;
 * the selected one's description and values in an editable table (or as text, for
 * pasting a column from a spreadsheet); and a chart. Renaming updates every reference,
 * and an object in use cannot be deleted (core `data.ts`). Pump curves show the curve
 * EPANET fits to one or three points.
 */

import {
  addCurve,
  addPattern,
  curveKindOf,
  curveProblem,
  deleteCurve,
  deletePattern,
  EditError,
  getfloat,
  readOption,
  renameCurve,
  renamePattern,
  unitLabel,
  updateCurve,
  updatePattern,
  type model,
} from '@waterstudio/core';
import { useId, useState, type ReactNode } from 'react';
import { LineChart, type Series } from '../charts/LineChart.tsx';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';
import { CommitInput, InputRow } from './fields.tsx';

/** Run an edit and turn an EditError into a message. */
function attempt(fn: () => void): string | undefined {
  try {
    fn();
    return undefined;
  } catch (e) {
    if (e instanceof EditError) return e.message;
    throw e;
  }
}

function numbersFrom(text: string): number[] | string {
  const parts = text.split(/[\s,;]+/).filter(Boolean);
  const out: number[] = [];
  for (const p of parts) {
    const v = getfloat(p);
    if (v === undefined) return `${p} is not a number.`;
    out.push(v);
  }
  return out;
}

function ObjectBar({
  what,
  ids,
  current,
  onSelect,
  onAdd,
  onDelete,
}: {
  what: string;
  ids: string[];
  current: string | undefined;
  onSelect: (id: string) => void;
  onAdd: () => string | undefined;
  onDelete: () => string | undefined;
}) {
  const [error, setError] = useState<string | null>(null);
  const selectId = useId();
  return (
    <>
      <div className="panel-toolbar">
        <label htmlFor={selectId}>{what}</label>
        <select
          id={selectId}
          value={current ?? ''}
          onChange={(e) => onSelect(e.target.value)}
          disabled={ids.length === 0}
        >
          {ids.length === 0 && <option value="">None</option>}
          {ids.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => setError(onAdd() ?? null)}>
          Add {what.toLowerCase()}
        </button>
        <button
          type="button"
          className="btn"
          disabled={!current}
          onClick={() => setError(onDelete() ?? null)}
        >
          Delete
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/** An editable column (or two) of numbers, with rows added and removed at the end. */
function ValueTable({
  caption,
  headers,
  rows,
  lead,
  onChange,
  newRow,
}: {
  caption: string;
  headers: string[];
  rows: number[][];
  /** A read-only first column (period times). */
  lead?: (i: number) => string;
  onChange: (rows: number[][]) => string | undefined;
  newRow: () => number[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [asText, setAsText] = useState(false);
  const text = rows.map((r) => r.join('\t')).join('\n');
  const [draft, setDraft] = useState(text);
  const [seen, setSeen] = useState(text);
  if (seen !== text) {
    setSeen(text);
    setDraft(text);
  }
  const cols = headers.length - (lead ? 1 : 0);
  return (
    <div className="value-table">
      <div className="panel-toolbar">
        <button type="button" className="btn" onClick={() => setError(onChange([...rows, newRow()]) ?? null)}>
          Add row
        </button>
        <button
          type="button"
          className="btn"
          disabled={rows.length === 0}
          onClick={() => setError(onChange(rows.slice(0, -1)) ?? null)}
        >
          Remove last row
        </button>
        <span className="spacer" />
        <button type="button" className="btn" aria-pressed={asText} onClick={() => setAsText(!asText)}>
          Edit as text
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {asText ? (
        <textarea
          className="value-text"
          aria-label={`${caption}: ${cols === 1 ? 'one value' : `${cols} values`} per line`}
          rows={10}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft === text) return;
            const lines = draft.split('\n').filter((l) => l.trim() !== '');
            const next: number[][] = [];
            if (cols === 1) {
              const v = numbersFrom(draft);
              if (typeof v === 'string') {
                setError(v);
                return;
              }
              for (const x of v) next.push([x]);
            } else {
              for (const [i, l] of lines.entries()) {
                const v = numbersFrom(l);
                if (typeof v === 'string') {
                  setError(v);
                  return;
                }
                if (v.length !== cols) {
                  setError(`Line ${i + 1} needs ${cols} numbers.`);
                  return;
                }
                next.push(v);
              }
            }
            setError(onChange(next) ?? null);
          }}
        />
      ) : (
        <div className="value-grid-wrap">
          <table className="value-grid">
            <caption className="sr-only">{caption}</caption>
            <thead>
              <tr>
                {headers.map((h) => (
                  <th key={h} scope="col">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  {lead && <th scope="row">{lead(i)}</th>}
                  {r.map((v, j) => (
                    <td key={j}>
                      <CommitInput
                        value={String(v)}
                        numeric
                        label={`${headers[j + (lead ? 1 : 0)]} ${i + 1}`}
                        onCommit={(t) => {
                          const n = getfloat(t.trim());
                          if (n === undefined) return 'Enter a number.';
                          const next = rows.map((row) => [...row]);
                          next[i]![j] = n;
                          const err = onChange(next);
                          setError(err ?? null);
                          return err;
                        }}
                        onError={(e) => e && setError(e)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Layout({ bar, children, chart }: { bar: ReactNode; children: ReactNode; chart: ReactNode }) {
  return (
    <div className="panel data-editor">
      {bar}
      <div className="data-editor-body">
        <div className="data-editor-form">{children}</div>
        <div className="data-editor-chart">{chart}</div>
      </div>
    </div>
  );
}

function hhmm(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

export function PatternsPanel() {
  const { state } = useApp();
  const patterns = state.store.doc.data.patterns;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const current = patterns.find((p) => p.id === picked) ?? patterns[0];
  const step = Number(readOption(state.store.doc.data.times, 'patternStep')?.[0] ?? 3600) || 3600;
  const store = state.store;

  const rename = (to: string) =>
    attempt(() => {
      if (!current) return;
      renamePattern(store, current.id, to);
      setPicked(to);
    });
  const bar = (
    <ObjectBar
      what="Pattern"
      ids={patterns.map((p) => p.id)}
      current={current?.id}
      onSelect={setPicked}
      onAdd={() => attempt(() => setPicked(addPattern(store, { multipliers: Array<number>(24).fill(1) })))}
      onDelete={() => attempt(() => current && deletePattern(store, current.id))}
    />
  );
  if (!current)
    return (
      <Layout bar={bar} chart={null}>
        {<p className="panel-empty">No time patterns.</p>}
      </Layout>
    );
  const m = current.multipliers;
  const series: Series[] = [
    {
      name: 'Multiplier',
      x: [...m.map((_, i) => (i * step) / 3600), (m.length * step) / 3600],
      y: [...m, m[m.length - 1] ?? 0],
    },
  ];
  return (
    <Layout
      bar={bar}
      chart={
        <LineChart
          title={`Pattern ${current.id}`}
          series={series}
          xLabel="Time (hours)"
          yLabel="Multiplier"
          step
        />
      }
    >
      <InputRow label="ID" value={current.id} onCommit={(t) => rename(t.trim())} />
      <InputRow
        label="Description"
        value={current.comment ?? ''}
        onCommit={(t) => attempt(() => updatePattern(store, current.id, { comment: t.trim() || null }))}
      />
      <p className="muted">
        Average {(m.reduce((a, b) => a + b, 0) / Math.max(1, m.length)).toFixed(3)} over {m.length} periods of{' '}
        {hhmm(step)}.
      </p>
      <ValueTable
        caption={`Multipliers of pattern ${current.id}`}
        headers={['Period', 'Multiplier']}
        rows={m.map((v) => [v])}
        lead={(i) => `${i + 1} (${hhmm(i * step)})`}
        onChange={(rows) =>
          attempt(() => updatePattern(store, current.id, { multipliers: rows.map((r) => r[0]!) }))
        }
        newRow={() => [m[m.length - 1] ?? 1]}
      />
    </Layout>
  );
}

const CURVE_KINDS: [model.CurveKind | '', string][] = [
  ['', 'Unspecified'],
  ['pump', 'Pump (head)'],
  ['efficiency', 'Pump efficiency'],
  ['volume', 'Tank volume'],
  ['headloss', 'GPV headloss'],
  ['valve', 'PCV position'],
  ['generic', 'Generic'],
];

function kindLabel(k: model.CurveKind): string {
  return CURVE_KINDS.find(([x]) => x === k)?.[1].toLowerCase() ?? k;
}

function axes(kind: model.CurveKind | null, state: AppState): [string, string] {
  const u = state.units;
  const q = `Flow (${unitLabel('flow', u)})`;
  switch (kind) {
    case 'pump':
      return [q, `Head (${unitLabel('head', u)})`];
    case 'efficiency':
      return [q, 'Efficiency (%)'];
    case 'volume':
      return [`Depth (${unitLabel('level', u)})`, `Volume (${unitLabel('volume', u)})`];
    case 'headloss':
      return [q, `Headloss (${unitLabel('head', u)})`];
    case 'valve':
      return ['Opening (%)', 'Flow coefficient (% of open)'];
    default:
      return ['X', 'Y'];
  }
}

/** EPANET's pump curve fit (`updatepumpparams`, `powercurve`): h = a − b·q^c, or undefined for a multi-point curve. */
export function pumpFit(
  points: readonly [number, number][],
): { a: number; b: number; c: number } | undefined {
  if (points.length === 1) {
    const [q, h] = points[0]!;
    if (q <= 0 || h <= 0) return undefined;
    const a = (4 / 3) * h;
    return { a, b: (a - h) / (q * q), c: 2 };
  }
  if (points.length === 3 && points[0]![0] === 0) {
    const [[, h0], [q1, h1], [q2, h2]] = points as [[number, number], [number, number], [number, number]];
    if (h0 < 1e-6 || h0 - h1 < 1e-6 || h1 - h2 < 1e-6 || q1 < 1e-6 || q2 - q1 < 1e-6) return undefined;
    const c = Math.log((h0 - h2) / (h0 - h1)) / Math.log(q2 / q1);
    if (c <= 0 || c > 20) return undefined;
    return { a: h0, b: (h0 - h1) / q1 ** c, c };
  }
  return undefined;
}

function fmt(v: number): string {
  const a = Math.abs(v);
  return a !== 0 && (a < 1e-3 || a >= 1e6) ? v.toExponential(3) : Number(v.toPrecision(4)).toString();
}

export function CurvesPanel() {
  const { state } = useApp();
  const curves = state.store.doc.data.curves;
  const [picked, setPicked] = useState<string | undefined>(undefined);
  const current = curves.find((c) => c.id === picked) ?? curves[0];
  const store = state.store;
  const kindId = useId();

  const rename = (to: string) =>
    attempt(() => {
      if (!current) return;
      renameCurve(store, current.id, to);
      setPicked(to);
    });
  const bar = (
    <ObjectBar
      what="Curve"
      ids={curves.map((c) => c.id)}
      current={current?.id}
      onSelect={setPicked}
      onAdd={() => attempt(() => setPicked(addCurve(store, { points: [[0, 0]] })))}
      onDelete={() => attempt(() => current && deleteCurve(store, current.id))}
    />
  );
  if (!current)
    return (
      <Layout bar={bar} chart={null}>
        {<p className="panel-empty">No curves.</p>}
      </Layout>
    );
  const kind = curveKindOf(state.store.doc, current.id);
  const [xl, yl] = axes(kind, state);
  const problem = curveProblem({ points: current.points, kind });
  const fit = kind === 'pump' && !problem ? pumpFit(current.points) : undefined;
  const series: Series[] = [
    { name: 'Points', x: current.points.map((p) => p[0]), y: current.points.map((p) => p[1]), dots: true },
  ];
  if (fit) {
    const qmax = (fit.a / fit.b) ** (1 / fit.c);
    const xs = Array.from({ length: 41 }, (_, i) => (qmax * i) / 40);
    series.push({ name: 'Fitted curve', x: xs, y: xs.map((q) => fit.a - fit.b * q ** fit.c) });
  }
  return (
    <Layout
      bar={bar}
      chart={<LineChart title={`Curve ${current.id}`} series={series} xLabel={xl} yLabel={yl} />}
    >
      <InputRow label="ID" value={current.id} onCommit={(t) => rename(t.trim())} />
      <div className="field-row">
        <label htmlFor={kindId}>Type</label>
        <div className="field-control">
          <select
            id={kindId}
            value={current.kind ?? ''}
            onChange={(e) =>
              attempt(() =>
                updateCurve(store, current.id, {
                  kind: e.target.value === '' ? null : (e.target.value as model.CurveKind),
                }),
              )
            }
          >
            {CURVE_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {k === '' && !current.kind && kind ? `${label} (used as ${kindLabel(kind)})` : label}
              </option>
            ))}
          </select>
        </div>
      </div>
      <InputRow
        label="Description"
        value={current.comment ?? ''}
        onCommit={(t) => attempt(() => updateCurve(store, current.id, { comment: t.trim() || null }))}
      />
      {problem && (
        <p className="field-error" role="status">
          {problem}
        </p>
      )}
      {fit && (
        <p className="muted">
          Head = {fmt(fit.a)} − {fmt(fit.b)} × Flow<sup>{fmt(fit.c)}</sup>
        </p>
      )}
      <ValueTable
        caption={`Points of curve ${current.id}`}
        headers={[xl, yl]}
        rows={current.points.map((p) => [p[0], p[1]])}
        onChange={(rows) =>
          attempt(() =>
            updateCurve(store, current.id, { points: rows.map((r) => [r[0]!, r[1]!] as [number, number]) }),
          )
        }
        newRow={() => {
          const lastPt = current.points[current.points.length - 1];
          return lastPt ? [lastPt[0] + 1, lastPt[1]] : [0, 0];
        }}
      />
    </Layout>
  );
}

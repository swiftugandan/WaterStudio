/**
 * Studies: fire flow at hydrants, the criticality of links and pipe sizing, run on the
 * engine pool (ws-study). Results are tables that sort worst first, select the elements that fail
 * on the map, and copy to the clipboard.
 */

import { cutOff, getfloat, hour, segments, unitLabel } from '@waterstudio/core';
import type { CriticalityResult, FireFlowResult } from '@waterstudio/engine-client';
import { useId, useState } from 'react';
import { useApp, useAppContext } from '../app/context.tsx';
import { copyText, tsv } from '../app/files.ts';
import type { AppState } from '../app/state.ts';
import { runCriticality, runFireFlow } from '../app/studies.ts';
import { SizingStudy } from './SizingStudy.tsx';

type Tab = 'fire' | 'criticality' | 'sizing' | 'segments';

const f = (v: number | null, d = 2) => (v === null || !Number.isFinite(v) ? '–' : v.toFixed(d));

function useRunner() {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<[number, number] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: (p: (d: number, t: number) => void) => Promise<void>) => {
    setBusy(true);
    setError(null);
    const t0 = performance.now();
    try {
      await fn((d, t) => setProgress([d, t]));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setElapsed(performance.now() - t0);
    }
  };
  const [elapsed, setElapsed] = useState<number | null>(null);
  return { busy, progress, error, run, elapsed };
}

function scope(state: AppState, table: 'node' | 'link', filter: (h: number) => boolean): string[] {
  const doc = state.store.doc;
  return [...state.selection]
    .filter((h) => doc.has(h) && (table === 'node' ? doc.isNode(h) : doc.isLink(h)) && filter(h))
    .map((h) => doc.id(h));
}

function FireFlow({ state }: { state: AppState }) {
  const u = state.units;
  const doc = state.store.doc;
  const [which, setWhich] = useState<'selected' | 'all'>('all');
  const [form, setForm] = useState({
    flow: u.si ? '60' : '1000',
    residual: u.si ? '14' : '20',
    systemMin: '',
    time: '0:00',
  });
  const [results, setResults] = useState<FireFlowResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const r = useRunner();
  const ids = { which: useId(), flow: useId(), res: useId(), sys: useId(), time: useId() };
  const junction = (h: number) => doc.isNode(h) && doc.nodeKind(h) === 'junction';
  const hydrants =
    which === 'all'
      ? [...doc.nodeHandles()].filter(junction).map((h) => doc.id(h))
      : scope(state, 'node', junction);
  const flowUnit = unitLabel('flow', u);
  const pUnit = unitLabel('pressure', u);

  const start = () => {
    const flow = getfloat(form.flow.trim());
    const residual = getfloat(form.residual.trim());
    const systemMin = form.systemMin.trim() === '' ? undefined : getfloat(form.systemMin.trim());
    const t = hour(form.time.trim().split(/\s+/)[0] ?? '', form.time.trim().split(/\s+/)[1] ?? '');
    if (flow === undefined || flow <= 0) {
      setFormError('The design flow must be a number above 0.');
      return;
    }
    if (residual === undefined) {
      setFormError('The residual pressure must be a number.');
      return;
    }
    if (form.systemMin.trim() !== '' && systemMin === undefined) {
      setFormError('The system minimum must be a number.');
      return;
    }
    if (t < 0) {
      setFormError('Enter the time of day as h:mm.');
      return;
    }
    if (hydrants.length === 0) {
      setFormError('Select junctions to test, or test all of them.');
      return;
    }
    setFormError(null);
    const m = state.sync;
    void r.run(async (p) => {
      const res = await runFireFlow(
        m,
        {
          hydrants,
          flow,
          residual,
          time: Math.round(t * 3600),
          ...(systemMin !== undefined ? { systemMin } : {}),
        },
        p,
      );
      setResults(
        [...res].sort((a, b) => Number(a.meets) - Number(b.meets) || a.availableFlow - b.availableFlow),
      );
    });
  };

  const field = (key: keyof typeof form, id: string, label: string, unit: string, placeholder?: string) => (
    <>
      <label htmlFor={id}>{label}</label>
      <span className="field-control">
        <input
          id={id}
          type="text"
          inputMode="decimal"
          value={form[key]}
          placeholder={placeholder}
          onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        />
        {unit && <span className="unit">{unit}</span>}
      </span>
    </>
  );

  return (
    <>
      <form
        className="query-grid"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label htmlFor={ids.which}>Hydrants</label>
        <select id={ids.which} value={which} onChange={(e) => setWhich(e.target.value as 'selected' | 'all')}>
          <option value="all">Every junction</option>
          <option value="selected">Selected junctions</option>
        </select>
        {field('flow', ids.flow, 'Design fire flow', flowUnit)}
        {field('residual', ids.res, 'Residual pressure', pUnit)}
        {field('systemMin', ids.sys, 'System minimum', pUnit, 'Not checked')}
        {field('time', ids.time, 'Time of day', '', 'h:mm')}
        <span />
        <button type="submit" className="btn primary" disabled={r.busy}>
          {r.busy ? 'Running…' : `Test ${hydrants.length} hydrant${hydrants.length === 1 ? '' : 's'}`}
        </button>
      </form>
      {(formError ?? r.error) && (
        <p className="field-error" role="alert">
          {formError ?? r.error}
        </p>
      )}
      {r.progress && (
        <p className="muted" role="status">
          {r.busy
            ? `${r.progress[0]} of ${r.progress[1]} hydrants`
            : `${r.progress[1]} hydrants tested${r.elapsed !== null ? ` in ${(r.elapsed / 1000).toFixed(1)} s` : ''}.`}
        </p>
      )}
      {results && !r.busy && (
        <>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                state.select(
                  results
                    .filter((x) => !x.meets)
                    .flatMap((x) => (doc.findNode(x.id) !== undefined ? [doc.findNode(x.id)!] : [])),
                )
              }
            >
              Select hydrants that fall short ({results.filter((x) => !x.meets).length})
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void copyText(
                  tsv([
                    [
                      'Hydrant',
                      `Static (${pUnit})`,
                      `Residual (${pUnit})`,
                      `Available (${flowUnit})`,
                      'Critical node',
                      `Critical (${pUnit})`,
                      'Meets',
                    ],
                    ...results.map((x) => [
                      x.id,
                      f(x.staticPressure),
                      f(x.residualPressure),
                      f(x.availableFlow, 1),
                      x.criticalNode ?? '',
                      f(x.criticalPressure),
                      x.meets ? 'yes' : 'no',
                    ]),
                  ]),
                )
              }
            >
              Copy
            </button>
          </div>
          <div className="chart-table-wrap">
            <table className="chart-table studies-table">
              <caption className="sr-only">Fire flow results, worst first</caption>
              <thead>
                <tr>
                  <th scope="col">Hydrant</th>
                  <th scope="col">Static ({pUnit})</th>
                  <th scope="col">Residual ({pUnit})</th>
                  <th scope="col">Available ({flowUnit})</th>
                  <th scope="col">Critical node</th>
                  <th scope="col">Meets</th>
                </tr>
              </thead>
              <tbody>
                {results.map((x) => (
                  <tr
                    key={x.id}
                    className={x.meets ? undefined : 'fails'}
                    onClick={() => {
                      const h = doc.findNode(x.id);
                      if (h !== undefined) state.select([h]);
                    }}
                  >
                    <th scope="row">{x.id}</th>
                    <td>{f(x.staticPressure)}</td>
                    <td>{f(x.residualPressure)}</td>
                    <td>{f(x.availableFlow, 1)}</td>
                    <td>
                      {x.criticalNode ?? '–'} {x.criticalNode ? `(${f(x.criticalPressure)})` : ''}
                    </td>
                    <td>{x.error ? x.error : x.meets ? 'Yes' : 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Criticality({ state }: { state: AppState }) {
  const u = state.units;
  const doc = state.store.doc;
  const [which, setWhich] = useState<'selected' | 'all'>('all');
  const [pressure, setPressure] = useState(u.si ? '20' : '30');
  const [results, setResults] = useState<CriticalityResult[] | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const r = useRunner();
  const ids = { which: useId(), p: useId() };
  const links = which === 'all' ? [] : scope(state, 'link', () => true);
  const count =
    which === 'all' ? [...doc.linkHandles()].filter((h) => doc.linkKind(h) === 'pipe').length : links.length;
  const pUnit = unitLabel('pressure', u);
  const flowUnit = unitLabel('flow', u);

  const start = () => {
    const p = getfloat(pressure.trim());
    if (p === undefined) {
      setFormError('The pressure must be a number.');
      return;
    }
    if (count === 0) {
      setFormError('Select links to test, or test every pipe.');
      return;
    }
    setFormError(null);
    const m = state.sync;
    void r.run(async (prog) => {
      const res = await runCriticality(m, { links, pressure: p }, prog);
      setResults(
        [...res].sort(
          (a, b) =>
            Number(b.failed) - Number(a.failed) || b.nodesBelow - a.nodesBelow || b.deficit - a.deficit,
        ),
      );
    });
  };
  const critical = (results ?? []).filter((x) => x.failed || x.nodesBelow > 0);

  return (
    <>
      <form
        className="query-grid"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label htmlFor={ids.which}>Links</label>
        <select id={ids.which} value={which} onChange={(e) => setWhich(e.target.value as 'selected' | 'all')}>
          <option value="all">Every pipe</option>
          <option value="selected">Selected links</option>
        </select>
        <label htmlFor={ids.p}>Minimum pressure</label>
        <span className="field-control">
          <input
            id={ids.p}
            type="text"
            inputMode="decimal"
            value={pressure}
            onChange={(e) => setPressure(e.target.value)}
          />
          <span className="unit">{pUnit}</span>
        </span>
        <span />
        <button type="submit" className="btn primary" disabled={r.busy}>
          {r.busy ? 'Running…' : `Take out ${count} link${count === 1 ? '' : 's'} in turn`}
        </button>
      </form>
      <p className="muted">
        Each link is closed for the whole simulation; junctions newly below the minimum are counted.
      </p>
      {(formError ?? r.error) && (
        <p className="field-error" role="alert">
          {formError ?? r.error}
        </p>
      )}
      {r.progress && (
        <p className="muted" role="status">
          {r.busy
            ? `${r.progress[0]} of ${r.progress[1]} links`
            : `${r.progress[1]} links tested${r.elapsed !== null ? ` in ${(r.elapsed / 1000).toFixed(1)} s` : ''}.`}
        </p>
      )}
      {results && !r.busy && (
        <>
          <div className="row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                state.select(
                  critical.flatMap((x) => (doc.findLink(x.id) !== undefined ? [doc.findLink(x.id)!] : [])),
                )
              }
            >
              Select critical links ({critical.length})
            </button>
            <button
              type="button"
              className="btn"
              onClick={() =>
                void copyText(
                  tsv([
                    [
                      'Link',
                      'Junctions below',
                      `Lowest pressure (${pUnit})`,
                      'At',
                      `Deficit (${flowUnit}·h)`,
                      'Failed',
                    ],
                    ...results.map((x) => [
                      x.id,
                      x.nodesBelow,
                      f(x.minPressure),
                      x.minNode ?? '',
                      f(x.deficit),
                      x.failed ? 'yes' : 'no',
                    ]),
                  ]),
                )
              }
            >
              Copy
            </button>
          </div>
          <div className="chart-table-wrap">
            <table className="chart-table studies-table">
              <caption className="sr-only">Criticality results, most critical first</caption>
              <thead>
                <tr>
                  <th scope="col">Link</th>
                  <th scope="col">Junctions below</th>
                  <th scope="col">Lowest ({pUnit})</th>
                  <th scope="col">At</th>
                  <th scope="col">Deficit ({flowUnit}·h)</th>
                </tr>
              </thead>
              <tbody>
                {results.map((x) => (
                  <tr
                    key={x.id}
                    className={x.failed || x.nodesBelow > 0 ? 'fails' : undefined}
                    onClick={() => {
                      const h = doc.findLink(x.id);
                      if (h !== undefined) state.select([h]);
                    }}
                  >
                    <th scope="row">{x.id}</th>
                    <td>{x.failed ? (x.error ?? 'Failed') : x.nodesBelow}</td>
                    <td>{f(x.minPressure)}</td>
                    <td>{x.minNode ?? '–'}</td>
                    <td>{f(x.deficit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function Segments({ state }: { state: AppState }) {
  const { bus } = useAppContext();
  const doc = state.store.doc;
  const valves = doc.data.isolationValves;
  const result = segments(doc, valves);
  const [isolated, setIsolated] = useState<{ index: number; lost: number } | null>(null);
  const rows = result.segments
    .map((s, i) => ({ s, i }))
    .filter((r) => r.s.links.some((l) => doc.linkKind(l) === 'pipe'))
    .sort((a, b) => b.s.length - a.s.length);
  const lengthUnit = unitLabel('length', state.units);
  return (
    <>
      <p className="muted">
        {valves.length} isolation valves make {rows.length} segments. Place valves with the Isolation valve
        tool (I) on the Draw tab, or by rule:
      </p>
      <div className="row">
        <button type="button" className="btn" onClick={() => bus.execute('segments.nMinus1')}>
          N−1 rule
        </button>
        <button type="button" className="btn" onClick={() => bus.execute('segments.everyEnd')}>
          Every pipe end
        </button>
        <button
          type="button"
          className="btn"
          disabled={valves.length === 0}
          onClick={() => bus.execute('segments.clear')}
        >
          Remove all
        </button>
      </div>
      {isolated && (
        <p role="status">
          Closing {result.segments[isolated.index]!.valves.length} valves isolates segment{' '}
          {isolated.index + 1}
          {isolated.lost > 0 ? ` and cuts off ${isolated.lost} more nodes from every source` : ''}.
        </p>
      )}
      <div className="chart-table-wrap">
        <table className="chart-table studies-table">
          <caption className="sr-only">Isolation segments, longest first</caption>
          <thead>
            <tr>
              <th scope="col">Segment</th>
              <th scope="col">Pipes</th>
              <th scope="col">Length ({lengthUnit})</th>
              <th scope="col">Nodes</th>
              <th scope="col">Valves</th>
              <th scope="col">
                <span className="sr-only">Isolate</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 500).map(({ s, i }) => (
              <tr key={i} onClick={() => state.select([...s.nodes, ...s.links])}>
                <th scope="row">{i + 1}</th>
                <td>{s.links.filter((l) => doc.linkKind(l) === 'pipe').length}</td>
                <td>{s.length.toFixed(0)}</td>
                <td>{s.nodes.length}</td>
                <td>{s.valves.length}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      const lost = cutOff(doc, result, i);
                      state.select([...s.nodes, ...s.links, ...lost]);
                      setIsolated({ index: i, lost: lost.length });
                    }}
                  >
                    Isolate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function StudiesPanel() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>('fire');
  return (
    <div className="panel studies">
      <div className="panel-toolbar">
        <div className="segmented" role="tablist" aria-label="Study">
          {(
            [
              ['fire', 'Fire flow'],
              ['criticality', 'Criticality'],
              ['sizing', 'Pipe sizing'],
              ['segments', 'Segments'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : undefined}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div
        role="tabpanel"
        aria-label={
          tab === 'fire'
            ? 'Fire flow'
            : tab === 'criticality'
              ? 'Criticality'
              : tab === 'sizing'
                ? 'Pipe sizing'
                : 'Segments'
        }
        className="studies-body"
      >
        {tab === 'fire' ? (
          <FireFlow state={state} />
        ) : tab === 'criticality' ? (
          <Criticality state={state} />
        ) : tab === 'sizing' ? (
          <SizingStudy state={state} />
        ) : (
          <Segments state={state} />
        )}
      </div>
    </div>
  );
}

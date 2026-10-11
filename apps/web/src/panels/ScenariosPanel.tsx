/**
 * The scenario manager: the base network and its scenarios as a tree, which one is
 * shown and edited, and a comparison of any two: both are run and the differences in
 * a result at the current report time are ranked, with summary figures.
 */

import { ScenarioError, type Scenario } from '@waterstudio/core';
import {
  linkFrame,
  LINK_VARIABLES,
  nodeFrame,
  NODE_VARIABLES,
  type LinkVariable,
  type NodeVariable,
  type RunResults,
} from '@waterstudio/engine-client';
import { useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';
import { variableLabel, variableNoun } from '../shell/Ribbon.tsx';
import { variableUnit } from '../viewport/paint.ts';

const BASE = '__base__';

function tree(list: Scenario[], parent: string | null, depth: number): { s: Scenario; depth: number }[] {
  return list
    .filter((s) => s.parent === parent)
    .flatMap((s) => [{ s, depth }, ...tree(list, s.id, depth + 1)]);
}

interface Comparison {
  a: string;
  b: string;
  table: 'node' | 'link';
  variable: string;
  period: number;
  ra: RunResults;
  rb: RunResults;
}

function Compare({ state }: { state: AppState }) {
  const sc = state.scenarios;
  const ids = { a: useId(), b: useId(), v: useId() };
  const [a, setA] = useState(BASE);
  // B follows the newest scenario until one is chosen.
  const [chosenB, setB] = useState<string | null>(null);
  const b =
    chosenB !== null && (chosenB === BASE || sc.get(chosenB)) ? chosenB : (sc.scenarios.at(-1)?.id ?? BASE);
  const [variable, setVariable] = useState('node:pressure');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cmp, setCmp] = useState<Comparison | null>(null);
  const name = (id: string) => (id === BASE ? 'Base network' : (sc.get(id)?.name ?? id));
  const options = [
    { id: BASE, name: 'Base network' },
    ...sc.scenarios.map((s) => ({ id: s.id, name: s.name })),
  ];

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const [ma, mb] = [a, b].map((id) => sc.modelFor(id === BASE ? null : id));
      const [ra, rb] = await Promise.all([state.engine.run(ma!), state.engine.run(mb!)]);
      const [table, v] = variable.split(':') as ['node' | 'link', string];
      setCmp({ a, b, table, variable: v, period: state.period, ra: ra.value, rb: rb.value });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  let body = null;
  if (cmp) {
    const doc = state.store.doc;
    const handles = [...(cmp.table === 'node' ? doc.nodeHandles() : doc.linkHandles())];
    const p = Math.min(cmp.period, cmp.ra.times.length - 1, cmp.rb.times.length - 1);
    const frame = (r: RunResults) =>
      cmp.table === 'node'
        ? nodeFrame(r, cmp.variable as NodeVariable, p)
        : linkFrame(r, cmp.variable as LinkVariable, p);
    const fa = frame(cmp.ra);
    const fb = frame(cmp.rb);
    const rows = handles
      .map((h, i) => ({ h, va: fa[i]!, vb: fb[i]!, d: fb[i]! - fa[i]! }))
      .filter((r) => Number.isFinite(r.d));
    const changed = rows.filter((r) => Math.abs(r.d) > 1e-6);
    const top = [...changed].sort((x, y) => Math.abs(y.d) - Math.abs(x.d)).slice(0, 20);
    const unit = variableUnit(cmp.variable, state.units);
    const stat = (f: Float32Array, fn: (a: number, b: number) => number) =>
      Array.from(f).filter(Number.isFinite).reduce(fn);
    const f3 = (v: number) => v.toFixed(state.prefs.places(cmp.variable));
    body = (
      <>
        <table className="chart-table">
          <caption>
            {variableLabel(cmp.variable)}
            {unit ? ` (${unit})` : ''}: {name(cmp.b)} against {name(cmp.a)}
          </caption>
          <thead>
            <tr>
              <th scope="col" />
              <th scope="col">{name(cmp.a)}</th>
              <th scope="col">{name(cmp.b)}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Minimum</th>
              <td>{f3(stat(fa, Math.min))}</td>
              <td>{f3(stat(fb, Math.min))}</td>
            </tr>
            <tr>
              <th scope="row">Maximum</th>
              <td>{f3(stat(fa, Math.max))}</td>
              <td>{f3(stat(fb, Math.max))}</td>
            </tr>
          </tbody>
        </table>
        <p role="status">
          {changed.length} of {rows.length} {cmp.table === 'node' ? 'nodes' : 'links'} differ.
        </p>
        {top.length > 0 && (
          <table className="chart-table compare-top">
            <caption className="sr-only">Largest differences</caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">{name(cmp.a)}</th>
                <th scope="col">{name(cmp.b)}</th>
                <th scope="col">Difference</th>
              </tr>
            </thead>
            <tbody>
              {top.map((r) => (
                <tr key={r.h} onClick={() => state.select([r.h])}>
                  <th scope="row">{doc.has(r.h) ? doc.id(r.h) : '?'}</th>
                  <td>{f3(r.va)}</td>
                  <td>{f3(r.vb)}</td>
                  <td>
                    {r.d > 0 ? '+' : ''}
                    {f3(r.d)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  }

  return (
    <section className="field-group" aria-label="Compare scenarios">
      <h3>Compare</h3>
      <div className="query-grid">
        <label htmlFor={ids.a}>Scenario A</label>
        <select id={ids.a} value={a} onChange={(e) => setA(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <label htmlFor={ids.b}>Scenario B</label>
        <select id={ids.b} value={b} onChange={(e) => setB(e.target.value)}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <label htmlFor={ids.v}>Result</label>
        <select id={ids.v} value={variable} onChange={(e) => setVariable(e.target.value)}>
          {NODE_VARIABLES.map((v) => (
            <option key={`n${v}`} value={`node:${v}`}>
              Node {variableNoun(v)}
            </option>
          ))}
          {LINK_VARIABLES.map((v) => (
            <option key={`l${v}`} value={`link:${v}`}>
              Link {variableNoun(v)}
            </option>
          ))}
        </select>
        <span />
        <button type="button" className="btn primary" disabled={busy || a === b} onClick={() => void run()}>
          {busy ? 'Running…' : 'Run both and compare'}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {body}
    </section>
  );
}

export function ScenariosPanel() {
  const { state } = useApp();
  const sc = state.scenarios;
  const [picked, setPicked] = useState<string>(BASE);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const rows = tree(sc.scenarios, null, 1);
  const activeId = sc.active ?? BASE;
  const attempt = (fn: () => void) => {
    try {
      fn();
      setMessage(null);
    } catch (e) {
      if (e instanceof ScenarioError) setMessage({ ok: false, text: e.message });
      else throw e;
    }
  };
  const item = (id: string, label: string, depth: number, count: number | null) => (
    <li
      key={id}
      role="option"
      aria-selected={picked === id}
      tabIndex={-1}
      className={`scenario-row${picked === id ? ' picked' : ''}`}
      style={{ paddingLeft: `calc(${depth} * var(--ws-space-4))` }}
      onClick={() => setPicked(id)}
      onDoubleClick={() => attempt(() => state.activateScenario(id === BASE ? null : id))}
    >
      <span>{label}</span>
      {activeId === id && <span className="badge-active">shown</span>}
      {count !== null && <span className="count">{count} changes</span>}
    </li>
  );
  return (
    <div className="panel scenarios">
      <div className="panel-toolbar">
        <button
          type="button"
          className="btn"
          onClick={() =>
            attempt(() => {
              const n = prompt('Name of the new scenario:', `Scenario ${sc.scenarios.length + 1}`);
              if (!n) return;
              const id = sc.create(n, picked === BASE ? null : picked);
              setPicked(id);
              state.emit();
            })
          }
        >
          New
        </button>
        <button
          type="button"
          className="btn primary"
          disabled={picked === activeId}
          onClick={() => attempt(() => state.activateScenario(picked === BASE ? null : picked))}
        >
          Show and edit
        </button>
        <button
          type="button"
          className="btn"
          disabled={picked === BASE}
          onClick={() =>
            attempt(() => {
              const n = prompt('New name:', sc.get(picked)?.name);
              if (!n) return;
              sc.rename(picked, n);
              state.emit();
            })
          }
        >
          Rename
        </button>
        <button
          type="button"
          className="btn"
          disabled={picked === BASE}
          onClick={() =>
            attempt(() => {
              sc.remove(picked);
              setPicked(BASE);
              state.emit();
            })
          }
        >
          Delete
        </button>
      </div>
      <ul
        className="scenario-tree"
        role="listbox"
        aria-label="Scenarios"
        tabIndex={0}
        aria-activedescendant={undefined}
        onKeyDown={(e) => {
          const order = [BASE, ...rows.map((r) => r.s.id)];
          const i = order.indexOf(picked);
          if (e.key === 'ArrowDown') setPicked(order[Math.min(order.length - 1, i + 1)]!);
          else if (e.key === 'ArrowUp') setPicked(order[Math.max(0, i - 1)]!);
          else if (e.key === 'Enter') attempt(() => state.activateScenario(picked === BASE ? null : picked));
          else return;
          e.preventDefault();
        }}
      >
        {item(BASE, 'Base network', 0, null)}
        {rows.map((r) => item(r.s.id, r.s.name, r.depth, sc.count(r.s.id)))}
      </ul>
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role="alert">
          {message.text}
        </p>
      )}
      <p className="muted">
        A scenario changes properties of its parent: demands, sizes, settings, controls, options. Adding,
        deleting or moving elements changes the network for every scenario.
      </p>
      <Compare state={state} />
    </div>
  );
}

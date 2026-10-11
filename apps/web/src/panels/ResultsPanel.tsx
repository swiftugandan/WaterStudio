/**
 * Results table: every node or link at the current report time, virtualised, sortable
 * by any column and filtered by a condition, as EPANET's network tables are.
 */

import { linkFrame, LINK_VARIABLES, nodeFrame, NODE_VARIABLES } from '@waterstudio/engine-client';
import { getfloat } from '@waterstudio/core';
import { useId, useState } from 'react';
import { holds, type Relation } from '../app/query.ts';
import { useApp } from '../app/context.tsx';
import { clock } from '../shell/TimeControl.tsx';
import { variableLabel } from '../shell/Ribbon.tsx';
import { variableUnit, type VARIABLE_QUANTITY } from '../viewport/paint.ts';
import { VirtualList } from './VirtualList.tsx';

export function ResultsPanel() {
  const { state } = useApp();
  const [table, setTable] = useState<'node' | 'link'>('node');
  const [sort, setSort] = useState<{ col: number; desc: boolean } | null>(null);
  const [filter, setFilter] = useState<{ col: number; relation: Relation; value: number } | null>(null);
  const [draft, setDraft] = useState<{ col: number; relation: Relation; value: string }>({
    col: 0,
    relation: 'below',
    value: '',
  });
  const ids = { col: useId(), rel: useId(), val: useId() };
  const r = state.run;
  if (r.status !== 'done' || !r.results || !r.nodes || !r.links) {
    return (
      <div className="panel results empty">
        <p>{r.status === 'running' ? 'Solving…' : 'Run hydraulics (F5) to see results here.'}</p>
      </div>
    );
  }
  const res = r.results;
  const doc = state.store.doc;
  const handles = table === 'node' ? r.nodes : r.links;
  const vars = table === 'node' ? NODE_VARIABLES : LINK_VARIABLES;
  const frames = vars.map((v) =>
    table === 'node' ? nodeFrame(res, v as never, state.period) : linkFrame(res, v as never, state.period),
  );
  const order = (() => {
    let rows = Array.from({ length: handles.length }, (_, i) => i);
    if (filter) rows = rows.filter((i) => holds(filter.relation, frames[filter.col]![i]!, filter.value));
    if (sort) {
      const sign = sort.desc ? -1 : 1;
      if (sort.col < 0) {
        const id = (i: number) => (doc.has(handles[i]!) ? doc.id(handles[i]!) : '');
        rows.sort((a, b) => sign * id(a).localeCompare(id(b), undefined, { numeric: true }));
      } else {
        const f = frames[sort.col]!;
        rows.sort((a, b) => sign * (f[a]! - f[b]! || 0));
      }
    }
    return rows;
  })();
  const u = state.units;
  const unit = (v: string) => {
    return variableUnit(v as keyof typeof VARIABLE_QUANTITY, u);
  };
  const cols = `minmax(80px, 1.2fr) repeat(${vars.length}, minmax(70px, 1fr))`;
  return (
    <div className="panel results">
      <div className="results-head">
        <div className="segmented" role="radiogroup" aria-label="Table">
          {(['node', 'link'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={table === t}
              className={table === t ? 'on' : undefined}
              onClick={() => {
                setTable(t);
                setSort(null);
                setFilter(null);
                setDraft({ col: 0, relation: 'below', value: '' });
              }}
            >
              {t === 'node' ? 'Nodes' : 'Links'}
            </button>
          ))}
        </div>
        <span className="muted">
          at {clock(res.reportStart + state.period * res.reportStep)}
          {state.stale ? ' — out of date' : ''}
        </span>
        <form
          className="results-filter"
          onSubmit={(e) => {
            e.preventDefault();
            const v = getfloat(draft.value.trim());
            setFilter(v === undefined ? null : { col: draft.col, relation: draft.relation, value: v });
          }}
        >
          <label htmlFor={ids.col}>Show where</label>
          <select
            id={ids.col}
            value={draft.col}
            onChange={(e) => setDraft({ ...draft, col: Number(e.target.value) })}
          >
            {vars.map((v, k) => (
              <option key={v} value={k}>
                {variableLabel(v)}
              </option>
            ))}
          </select>
          <select
            id={ids.rel}
            aria-label="Relation"
            value={draft.relation}
            onChange={(e) => setDraft({ ...draft, relation: e.target.value as Relation })}
          >
            <option value="below">is below</option>
            <option value="equal">equals</option>
            <option value="above">is above</option>
          </select>
          <input
            id={ids.val}
            aria-label="Filter value"
            type="text"
            inputMode="decimal"
            value={draft.value}
            onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          />
          <button type="submit" className="btn">
            Filter
          </button>
          {filter && (
            <button type="button" className="btn" onClick={() => setFilter(null)}>
              Show all
            </button>
          )}
        </form>
        <span className="muted" role="status">
          {filter ? `${order.length} of ${handles.length}` : `${handles.length}`}{' '}
          {table === 'node' ? 'nodes' : 'links'}
        </span>
      </div>
      <div className="grid-row grid-header" style={{ gridTemplateColumns: cols }}>
        <SortButton label="ID" col={-1} sort={sort} setSort={setSort} />
        {vars.map((v, k) => (
          <span key={v} className="num" title={unit(v)}>
            <SortButton label={variableLabel(v)} unit={unit(v)} col={k} sort={sort} setSort={setSort} />
          </span>
        ))}
      </div>
      <VirtualList
        label={`${table} results`}
        count={order.length}
        rowHeight={24}
        className="grid-body"
        onActivate={(i, mode) => state.select([handles[order[i]!]!], mode)}
        isSelected={(i) => state.selection.has(handles[order[i]!]!)}
        render={(i) => {
          const row = order[i]!;
          const h = handles[row]!;
          return (
            <div
              key={h}
              className={`grid-row vrow${state.selection.has(h) ? ' selected' : ''}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => state.select([h])}
              onDoubleClick={() => state.view?.zoomTo([h])}
            >
              <span>{doc.has(h) ? doc.id(h) : '(deleted)'}</span>
              {frames.map((f, k) => (
                <span key={k} className="num">
                  {f[row]!.toFixed(vars[k] === 'status' ? 0 : 2)}
                </span>
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}

function SortButton({
  label,
  unit,
  col,
  sort,
  setSort,
}: {
  label: string;
  unit?: string;
  col: number;
  sort: { col: number; desc: boolean } | null;
  setSort: (s: { col: number; desc: boolean } | null) => void;
}) {
  const on = sort?.col === col;
  return (
    <button
      type="button"
      className={`sort${on ? ' on' : ''}`}
      aria-label={`Sort by ${label}${on ? (sort.desc ? ', descending' : ', ascending') : ''}`}
      onClick={() => setSort(!on ? { col, desc: false } : sort.desc ? null : { col, desc: true })}
    >
      {label}
      {unit && <small> {unit}</small>}
      {on && <span aria-hidden="true">{sort.desc ? ' ▼' : ' ▲'}</span>}
    </button>
  );
}

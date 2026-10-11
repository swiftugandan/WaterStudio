/** Results table: every node or link at the current report time, virtualised. */

import { unitLabel } from '@waterstudio/core';
import { linkFrame, LINK_VARIABLES, nodeFrame, NODE_VARIABLES } from '@waterstudio/engine-client';
import { useState } from 'react';
import { useApp } from '../app/context.tsx';
import { clock } from '../shell/TimeControl.tsx';
import { variableLabel } from '../shell/Ribbon.tsx';
import { VARIABLE_QUANTITY } from '../viewport/paint.ts';
import { VirtualList } from './VirtualList.tsx';

export function ResultsPanel() {
  const { state } = useApp();
  const [table, setTable] = useState<'node' | 'link'>('node');
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
  const u = state.units;
  const unit = (v: string) => {
    const q = VARIABLE_QUANTITY[v as keyof typeof VARIABLE_QUANTITY];
    return q === 'headloss' ? (u.si ? 'm/km' : 'ft/kft') : unitLabel(q, u);
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
              onClick={() => setTable(t)}
            >
              {t === 'node' ? 'Nodes' : 'Links'}
            </button>
          ))}
        </div>
        <span className="muted">
          at {clock(res.reportStart + state.period * res.reportStep)}
          {state.stale ? ' — out of date' : ''}
        </span>
      </div>
      <div className="grid-row grid-header" style={{ gridTemplateColumns: cols }}>
        <span>ID</span>
        {vars.map((v) => (
          <span key={v} className="num" title={unit(v)}>
            {variableLabel(v)}
            {unit(v) && <small> {unit(v)}</small>}
          </span>
        ))}
      </div>
      <VirtualList
        label={`${table} results`}
        count={handles.length}
        rowHeight={24}
        className="grid-body"
        render={(i) => {
          const h = handles[i]!;
          return (
            <div
              key={h}
              role="listitem"
              className={`grid-row vrow${state.selection.has(h) ? ' selected' : ''}`}
              style={{ gridTemplateColumns: cols }}
              onClick={() => state.select([h])}
              onDoubleClick={() => state.view?.zoomTo([h])}
            >
              <span>{doc.has(h) ? doc.id(h) : '(deleted)'}</span>
              {frames.map((f, k) => (
                <span key={k} className="num">
                  {f[i]!.toFixed(vars[k] === 'status' ? 0 : 2)}
                </span>
              ))}
            </div>
          );
        }}
      />
    </div>
  );
}

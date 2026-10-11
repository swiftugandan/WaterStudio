/**
 * The inspector: the selected elements' fields, grouped as the catalogue groups them,
 * with units, inline validation and mixed values when several elements are selected.
 * Below the fields, the element's results at the current report time.
 */

import {
  EditError,
  fieldsOf,
  setField,
  unitLabel,
  type ElementKind,
  type FieldSpec,
} from '@waterstudio/core';
import { linkFrame, LINK_VARIABLES, nodeFrame, NODE_VARIABLES } from '@waterstudio/engine-client';
import { useEffect, useState } from 'react';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';
import { variableLabel } from '../shell/Ribbon.tsx';
import { variableUnit } from '../viewport/paint.ts';

const MIXED = Symbol('mixed');

function common(state: AppState, handles: number[], field: string): unknown {
  const doc = state.store.doc;
  const first = doc.get(handles[0]!, field);
  for (const h of handles) {
    const v = doc.get(h, field);
    if (!Object.is(v, first) && JSON.stringify(v) !== JSON.stringify(first)) return MIXED;
  }
  return first;
}

function format(v: unknown): string {
  if (v === MIXED) return '';
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isNaN(v) ? '' : String(v);
  return typeof v === 'string' ? v : JSON.stringify(v);
}

function FieldEditor({ spec, handles, state }: { spec: FieldSpec; handles: number[]; state: AppState }) {
  const value = common(state, handles, spec.name);
  const doc = state.store.doc;
  const [text, setText] = useState(format(value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(format(value));
    setError(null);
  }, [value]);
  const id = `f-${spec.name}`;
  const unit = unitLabel(spec.quantity, state.units);

  const commit = (raw: unknown) => {
    try {
      setField(state.store, handles, spec.name, raw);
      setError(null);
    } catch (e) {
      if (e instanceof EditError) setError(e.message);
      else throw e;
    }
  };

  let control;
  const ed = spec.editor;
  switch (ed.type) {
    case 'number':
    case 'text':
      control = (
        <input
          id={id}
          type="text"
          inputMode={ed.type === 'number' ? 'decimal' : 'text'}
          value={text}
          placeholder={value === MIXED ? 'Mixed' : ed.type === 'number' && ed.optional ? 'None' : ''}
          aria-invalid={error !== null}
          aria-describedby={error ? `${id}-err` : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            if (text === format(value)) return;
            if (ed.type === 'number') {
              const n = text.trim() === '' && ed.optional ? NaN : Number(text);
              if (text.trim() !== '' && !Number.isFinite(n)) {
                setError(`${spec.label} must be a number.`);
                return;
              }
              commit(n);
            } else if (spec.name === 'id') commit(text.trim());
            else commit(text === '' ? null : text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
            if (e.key === 'Escape') {
              setText(format(value));
              setError(null);
            }
          }}
        />
      );
      break;
    case 'enum':
      control = (
        <select
          id={id}
          value={value === MIXED ? '' : String(value)}
          onChange={(e) => commit(Number(e.target.value))}
        >
          {value === MIXED && <option value="">Mixed</option>}
          {ed.options.map((o, i) => (
            <option key={o} value={i}>
              {o}
            </option>
          ))}
        </select>
      );
      break;
    case 'pattern':
    case 'curve': {
      const list = ed.type === 'pattern' ? doc.data.patterns : doc.data.curves;
      control = (
        <select
          id={id}
          value={value === MIXED ? '\u0000' : ((value as string | null) ?? '')}
          onChange={(e) => commit(e.target.value === '' ? null : e.target.value)}
        >
          {value === MIXED && <option value={'\u0000'}>Mixed</option>}
          <option value="">None</option>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id}
            </option>
          ))}
        </select>
      );
      break;
    }
    case 'node':
      control = (
        <output id={id}>
          {value === MIXED ? 'Mixed' : doc.has(value as number) ? doc.id(value as number) : ''}
        </output>
      );
      break;
    case 'none':
      return null;
  }
  return (
    <div className={`field-row${error ? ' invalid' : ''}`}>
      <label htmlFor={id} title={spec.help}>
        {spec.label}
      </label>
      <div className="field-control">
        {control}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {error && (
        <div className="field-error" id={`${id}-err`} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

function DemandSummary({ state, handle }: { state: AppState; handle: number }) {
  const demands = state.store.doc.get(handle, 'demands') as {
    base: number;
    pattern: string | null;
    category: string | null;
  }[];
  const unit = unitLabel('flow', state.units);
  return (
    <div className="field-row">
      <span className="label">Demands</span>
      <ul className="demand-list">
        {demands.length === 0 && <li>None</li>}
        {demands.map((d, i) => (
          <li key={i}>
            {d.base} {unit}
            {d.pattern ? ` × pattern ${d.pattern}` : ''}
            {d.category ? ` (${d.category})` : ''}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultValues({ state, handle }: { state: AppState; handle: number }) {
  const r = state.run;
  if (r.status !== 'done' || !r.results || !r.nodes || !r.links) return null;
  const doc = state.store.doc;
  const isNode = doc.isNode(handle);
  const idx = (isNode ? r.nodes : r.links).indexOf(handle);
  if (idx < 0) return null;
  const vars = isNode ? NODE_VARIABLES : LINK_VARIABLES;
  const u = state.units;
  return (
    <section className="results-values" aria-label="Results at this time">
      <h3>Results{state.stale ? ' (out of date)' : ''}</h3>
      <dl>
        {vars.map((v) => {
          const frame = isNode
            ? nodeFrame(r.results!, v as (typeof NODE_VARIABLES)[number], state.period)
            : linkFrame(r.results!, v as (typeof LINK_VARIABLES)[number], state.period);
          const unit = variableUnit(v, u);
          const val = frame[idx]!;
          return (
            <div key={v}>
              <dt>{variableLabel(v)}</dt>
              <dd>
                {v === 'status' ? (STATUS[val] ?? val) : val.toFixed(3)} {v === 'status' ? '' : unit}
              </dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

const STATUS: Record<number, string> = {
  0: 'Closed (max head exceeded)',
  1: 'Temporarily closed',
  2: 'Closed',
  3: 'Open',
  4: 'Active',
  5: 'Open (flow limit)',
  6: 'Open (FCV cannot deliver)',
  7: 'Open (pressure not met)',
  8: 'Filling',
  9: 'Emptying',
  10: 'Overflowing',
};

export function PropertiesPanel() {
  const { state } = useApp();
  const doc = state.store.doc;
  const handles = [...state.selection].filter((h) => doc.has(h));
  if (handles.length === 0) {
    return (
      <div className="panel properties empty">
        <p>Select an element on the map or in the browser to see its properties.</p>
      </div>
    );
  }
  const kinds = new Set<ElementKind>(handles.map((h) => doc.kind(h)));
  if (kinds.size > 1) {
    return (
      <div className="panel properties empty">
        <p>
          {handles.length} elements of {kinds.size} types selected. Select elements of one type to edit them
          together.
        </p>
      </div>
    );
  }
  const kind = [...kinds][0]!;
  const fields = fieldsOf(kind).filter(
    (f) => f.editor.type !== 'none' && !(handles.length > 1 && f.name === 'id'),
  );
  const groups = [...new Set(fields.map((f) => f.group))];
  const title =
    handles.length === 1
      ? `${kind[0]!.toUpperCase()}${kind.slice(1)} ${doc.id(handles[0]!)}`
      : `${handles.length} ${kind}s`;
  return (
    <div className="panel properties" key={handles.join(',')}>
      <h2 className="panel-title">{title}</h2>
      {groups.map((g) => (
        <section key={g} className="field-group" aria-label={g}>
          <h3>{g}</h3>
          {fields
            .filter((f) => f.group === g)
            .map((f) => (
              <FieldEditor key={f.name} spec={f} handles={handles} state={state} />
            ))}
          {g === 'Hydraulics' && kind === 'junction' && handles.length === 1 && (
            <DemandSummary state={state} handle={handles[0]!} />
          )}
        </section>
      ))}
      {handles.length === 1 && <ResultValues state={state} handle={handles[0]!} />}
    </div>
  );
}

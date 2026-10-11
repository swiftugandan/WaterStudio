/**
 * Find, query and group edit, as EPANET's View › Find, View › Query and Edit › Group
 * Edit: find an element by ID; select the nodes or links meeting a condition on a
 * property or a result; and set, scale or offset a property of the selected elements
 * in one undoable step.
 */

import { EditError, getfloat, groupEdit, type GroupAction } from '@waterstudio/core';
import { useEffect, useId, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { attributes, matching, numericFields, type Relation } from '../app/query.ts';
import type { AppState } from '../app/state.ts';

function Find({ state }: { state: AppState }) {
  const [id, setId] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const request = state.findRequest;
  useEffect(() => {
    if (request > 0) input.current?.focus();
  }, [request]);
  const find = () => {
    const doc = state.store.doc;
    const t = id.trim();
    const h = doc.findNode(t) ?? doc.findLink(t);
    if (h === undefined) {
      setMessage({ ok: false, text: `There is no node or link ${t}.` });
      return;
    }
    state.select([h]);
    state.view?.zoomTo([h]);
    setMessage({ ok: true, text: `Found ${doc.kind(h)} ${t}.` });
  };
  return (
    <section className="field-group" aria-labelledby={`${inputId}-h`}>
      <h3 id={`${inputId}-h`}>Find</h3>
      <form
        className="query-row"
        onSubmit={(e) => {
          e.preventDefault();
          find();
        }}
      >
        <label htmlFor={inputId}>Node or link ID</label>
        <input id={inputId} ref={input} type="search" value={id} onChange={(e) => setId(e.target.value)} />
        <button type="submit" className="btn" disabled={id.trim() === ''}>
          Find
        </button>
      </form>
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}

function Query({ state }: { state: AppState }) {
  const [table, setTable] = useState<'node' | 'link'>('node');
  const attrs = attributes(state, table);
  const [attribute, setAttribute] = useState(attrs[0]?.id ?? '');
  const [relation, setRelation] = useState<Relation>('below');
  const [value, setValue] = useState('');
  const [within, setWithin] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { attr: useId(), rel: useId(), val: useId(), within: useId(), h: useId() };
  const current = attrs.find((a) => a.id === attribute) ?? attrs[0];
  const run = () => {
    const v = getfloat(value.trim());
    if (v === undefined || !current) {
      setMessage({ ok: false, text: 'Enter a number to compare with.' });
      return;
    }
    const found = matching(
      state,
      { table, attribute: current.id, relation, value: v },
      within ? state.selection : undefined,
    );
    state.select(found);
    setMessage({
      ok: true,
      text: `${found.length} ${table === 'node' ? 'node' : 'link'}${found.length === 1 ? '' : 's'} selected.`,
    });
  };
  return (
    <section className="field-group" aria-labelledby={ids.h}>
      <h3 id={ids.h}>Select where</h3>
      <div className="segmented" role="radiogroup" aria-label="Elements">
        {(['node', 'link'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={table === t}
            className={table === t ? 'on' : undefined}
            onClick={() => {
              setTable(t);
              setAttribute(attributes(state, t)[0]?.id ?? '');
            }}
          >
            {t === 'node' ? 'Nodes' : 'Links'}
          </button>
        ))}
      </div>
      <form
        className="query-grid"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        <label htmlFor={ids.attr}>Attribute</label>
        <select id={ids.attr} value={current?.id ?? ''} onChange={(e) => setAttribute(e.target.value)}>
          {attrs.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
              {a.unit ? ` (${a.unit})` : ''}
            </option>
          ))}
        </select>
        <label htmlFor={ids.rel}>Relation</label>
        <select id={ids.rel} value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
          <option value="below">Below</option>
          <option value="equal">Equal to</option>
          <option value="above">Above</option>
        </select>
        <label htmlFor={ids.val}>Value</label>
        <input
          id={ids.val}
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <span />
        <label className="check" htmlFor={ids.within}>
          <input
            id={ids.within}
            type="checkbox"
            checked={within}
            onChange={(e) => setWithin(e.target.checked)}
          />
          <span>Only within the current selection</span>
        </label>
        <span />
        <button type="submit" className="btn primary">
          Select
        </button>
      </form>
      {current?.result && state.stale && <p className="muted">Results are out of date.</p>}
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}

function GroupEdit({ state }: { state: AppState }) {
  const doc = state.store.doc;
  const selected = [...state.selection].filter((h) => doc.has(h));
  const nodes = selected.filter((h) => doc.isNode(h)).length;
  const table: 'node' | 'link' = nodes >= selected.length - nodes ? 'node' : 'link';
  const fields = numericFields(table).filter((f) => f.name !== 'id');
  const [field, setField] = useState(fields[0]?.name ?? '');
  const [action, setAction] = useState<GroupAction>('replace');
  const [value, setValue] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { field: useId(), action: useId(), val: useId(), h: useId() };
  const spec = fields.find((f) => f.name === field) ?? fields[0];
  const apply = () => {
    const v = getfloat(value.trim());
    if (v === undefined || !spec) {
      setMessage({ ok: false, text: 'Enter a number.' });
      return;
    }
    try {
      const n = groupEdit(state.store, selected, spec.name, action, v);
      setMessage({
        ok: true,
        text: n
          ? `Changed ${spec.label.toLowerCase()} of ${n} elements.`
          : 'None of the selected elements has that property.',
      });
    } catch (e) {
      if (e instanceof EditError) setMessage({ ok: false, text: e.message });
      else throw e;
    }
  };
  return (
    <section className="field-group" aria-labelledby={ids.h}>
      <h3 id={ids.h}>Group edit</h3>
      {selected.length === 0 ? (
        <p className="muted">Select elements on the map, or with the query above, to edit them together.</p>
      ) : (
        <form
          className="query-grid"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <span className="label">Selected</span>
          <span>
            {selected.length} {table === 'node' ? 'nodes' : 'links'}
            {selected.length !== (table === 'node' ? nodes : selected.length - nodes)
              ? ' (others are skipped)'
              : ''}
          </span>
          <label htmlFor={ids.field}>Property</label>
          <select id={ids.field} value={spec?.name ?? ''} onChange={(e) => setField(e.target.value)}>
            {fields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label}
              </option>
            ))}
          </select>
          <label htmlFor={ids.action}>Action</label>
          <select id={ids.action} value={action} onChange={(e) => setAction(e.target.value as GroupAction)}>
            <option value="replace">Replace with</option>
            <option value="multiply">Multiply by</option>
            <option value="add">Add</option>
          </select>
          <label htmlFor={ids.val}>Value</label>
          <input
            id={ids.val}
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <span />
          <button type="submit" className="btn primary">
            Apply
          </button>
        </form>
      )}
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </section>
  );
}

export function QueryPanel() {
  const { state } = useApp();
  return (
    <div className="panel query">
      <Find state={state} />
      <Query state={state} />
      <GroupEdit state={state} />
    </div>
  );
}

/**
 * Adding elements without the pointer: a node at typed coordinates, or a link between
 * two nodes named by ID. The keyboard path to everything the drawing tools do (WCAG
 * 2.1.1); the new element is selected so the inspector can edit it straight away.
 */

import { addLink, addNode, EditError, getfloat, type LinkKind, type NodeKind } from '@waterstudio/core';
import { useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { autoLength } from '../app/geometry.ts';
import { newElement } from '../app/defaults.ts';

const KINDS: [NodeKind | LinkKind, string][] = [
  ['junction', 'Junction'],
  ['reservoir', 'Reservoir'],
  ['tank', 'Tank'],
  ['pipe', 'Pipe'],
  ['pump', 'Pump'],
  ['valve', 'Valve'],
];
const isNode = (k: string): k is NodeKind => k === 'junction' || k === 'reservoir' || k === 'tank';

export function AddPanel() {
  const { state } = useApp();
  const [kind, setKind] = useState<NodeKind | LinkKind>('junction');
  const [f, setF] = useState({ id: '', x: '', y: '', from: '', to: '' });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const ids = { kind: useId(), id: useId(), x: useId(), y: useId(), from: useId(), to: useId() };
  const doc = state.store.doc;
  const cursor = state.cursor;

  const add = () => {
    try {
      const id = f.id.trim() || undefined;
      let h: number;
      if (isNode(kind)) {
        const x = getfloat(f.x.trim());
        const y = getfloat(f.y.trim());
        if (x === undefined || y === undefined)
          throw new EditError('Enter the X and Y coordinates as numbers.');
        const init = newElement(state, kind);
        h = addNode(state.store, kind, {
          x,
          y,
          values: init.values,
          ...((id ?? init.id) ? { id: id ?? init.id } : {}),
        });
      } else {
        const from = doc.findNode(f.from.trim());
        const to = doc.findNode(f.to.trim());
        if (from === undefined) throw new EditError(`There is no node ${f.from.trim() || '(empty)'}.`);
        if (to === undefined) throw new EditError(`There is no node ${f.to.trim() || '(empty)'}.`);
        const values = autoLength(state, kind, [
          doc.num(from, 'x'),
          doc.num(from, 'y'),
          doc.num(to, 'x'),
          doc.num(to, 'y'),
        ]);
        const init = newElement(state, kind);
        h = addLink(state.store, kind, {
          from,
          to,
          values: { ...init.values, ...values },
          ...((id ?? init.id) ? { id: id ?? init.id } : {}),
        });
      }
      state.select([h]);
      setMessage({ ok: true, text: `Added ${kind} ${doc.id(h)}.` });
      setF({ ...f, id: '' });
    } catch (e) {
      if (e instanceof EditError) setMessage({ ok: false, text: e.message });
      else throw e;
    }
  };

  const field = (key: keyof typeof f, label: string, numeric = false) => (
    <>
      <label htmlFor={ids[key]}>{label}</label>
      <input
        id={ids[key]}
        type="text"
        inputMode={numeric ? 'decimal' : 'text'}
        value={f[key]}
        onChange={(e) => setF({ ...f, [key]: e.target.value })}
      />
    </>
  );

  return (
    <div className="panel add-element">
      <form
        className="query-grid"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <label htmlFor={ids.kind}>Type</label>
        <select id={ids.kind} value={kind} onChange={(e) => setKind(e.target.value as NodeKind | LinkKind)}>
          {KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        {field('id', 'ID (optional)')}
        {isNode(kind) ? (
          <>
            {field('x', 'X', true)}
            {field('y', 'Y', true)}
          </>
        ) : (
          <>
            {field('from', 'Start node')}
            {field('to', 'End node')}
          </>
        )}
        <span />
        <button type="submit" className="btn primary">
          Add
        </button>
      </form>
      {isNode(kind) && cursor && (
        <button
          type="button"
          className="btn"
          onClick={() => setF({ ...f, x: cursor[0].toFixed(2), y: cursor[1].toFixed(2) })}
        >
          Use the last map position
        </button>
      )}
      {message && (
        <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </div>
  );
}

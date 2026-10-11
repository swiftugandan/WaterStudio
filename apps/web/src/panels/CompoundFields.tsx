/**
 * Inspector editors for fields that hold more than one value: a junction's demand
 * categories, a node's water quality source and a tank's mixing model. Each change goes
 * through `setField`, so it is one undoable edit and validated like any other.
 */

import { EditError, getfloat, setField, unitLabel, type model } from '@waterstudio/core';
import { useId, useState } from 'react';
import type { AppState } from '../app/state.ts';
import { CommitInput, Row } from './fields.tsx';

function commit(state: AppState, handles: number[], field: string, value: unknown): string | undefined {
  try {
    setField(state.store, handles, field, value);
    return undefined;
  } catch (e) {
    if (e instanceof EditError) return e.message;
    throw e;
  }
}

function PatternSelect({
  state,
  value,
  onChange,
  label,
  id,
}: {
  state: AppState;
  value: string | null;
  onChange: (v: string | null) => void;
  label?: string;
  id?: string;
}) {
  const patterns = state.store.doc.data.patterns;
  return (
    <select id={id} aria-label={label} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">None</option>
      {value !== null && !patterns.some((p) => p.id === value) && (
        <option value={value}>{value} (missing)</option>
      )}
      {patterns.map((p) => (
        <option key={p.id} value={p.id}>
          {p.id}
        </option>
      ))}
    </select>
  );
}

export function DemandsEditor({ state, handle }: { state: AppState; handle: number }) {
  const demands = state.store.doc.get(handle, 'demands') as model.Demand[];
  const [error, setError] = useState<string | null>(null);
  const flow = unitLabel('flow', state.units);
  const set = (next: model.Demand[]) => setError(commit(state, [handle], 'demands', next) ?? null);
  const update = (i: number, patch: Partial<model.Demand>) =>
    set(demands.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  return (
    <div className="demands-editor">
      <table className="value-grid">
        <caption className="label">Demands</caption>
        <thead>
          <tr>
            <th scope="col">Base ({flow})</th>
            <th scope="col">Pattern</th>
            <th scope="col">Category</th>
            <th scope="col">
              <span className="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {demands.map((d, i) => (
            <tr key={i}>
              <td>
                <CommitInput
                  value={String(d.base)}
                  numeric
                  label={`Base demand ${i + 1}`}
                  onCommit={(t) => {
                    const v = getfloat(t.trim());
                    if (v === undefined) return 'Base demand must be a number.';
                    update(i, { base: v });
                    return undefined;
                  }}
                  onError={(e) => e && setError(e)}
                />
              </td>
              <td>
                <PatternSelect
                  state={state}
                  label={`Pattern of demand ${i + 1}`}
                  value={d.pattern}
                  onChange={(p) => update(i, { pattern: p })}
                />
              </td>
              <td>
                <CommitInput
                  value={d.category ?? ''}
                  label={`Category of demand ${i + 1}`}
                  onCommit={(t) => {
                    update(i, { category: t.trim() || null });
                    return undefined;
                  }}
                />
              </td>
              <td>
                <button
                  type="button"
                  className="btn icon-only"
                  aria-label={`Remove demand ${i + 1}`}
                  title="Remove"
                  disabled={demands.length <= 1}
                  onClick={() => set(demands.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        className="btn"
        onClick={() => set([...demands, { base: 0, pattern: null, category: null }])}
      >
        Add demand category
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const SOURCE_KINDS: [model.SourceKind, string][] = [
  ['concen', 'Concentration'],
  ['mass', 'Mass booster'],
  ['setpoint', 'Set-point booster'],
  ['flowPaced', 'Flow-paced booster'],
];

export function SourceEditor({ state, handle }: { state: AppState; handle: number }) {
  const src = state.store.doc.get(handle, 'source') as model.Source | null;
  const [error, setError] = useState<string | null>(null);
  const kindId = useId();
  const strengthId = useId();
  const patternId = useId();
  const set = (next: model.Source | null) => setError(commit(state, [handle], 'source', next) ?? null);
  const q = state.units.quality;
  const strengthUnit = src?.kind === 'mass' ? 'mass/min' : q.units;
  return (
    <>
      <Row label="Source type" htmlFor={kindId} help="A water quality source at this node." error={error}>
        <select
          id={kindId}
          value={src?.kind ?? ''}
          onChange={(e) =>
            set(
              e.target.value === ''
                ? null
                : {
                    kind: e.target.value as model.SourceKind,
                    strength: src?.strength ?? 1,
                    pattern: src?.pattern ?? null,
                  },
            )
          }
        >
          <option value="">None</option>
          {SOURCE_KINDS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      {src && (
        <>
          <Row
            label="Source strength"
            htmlFor={strengthId}
            unit={strengthUnit}
            help="Baseline concentration or mass flow."
          >
            <CommitInput
              id={strengthId}
              value={String(src.strength)}
              numeric
              onCommit={(t) => {
                const v = getfloat(t.trim());
                if (v === undefined) return 'Strength must be a number.';
                set({ ...src, strength: v });
                return undefined;
              }}
              onError={setError}
            />
          </Row>
          <Row label="Source pattern" htmlFor={patternId} help="Time pattern of the source strength.">
            <PatternSelect
              state={state}
              id={patternId}
              value={src.pattern}
              onChange={(p) => set({ ...src, pattern: p })}
            />
          </Row>
        </>
      )}
    </>
  );
}

const MIX_MODELS: [model.MixModel, string][] = [
  ['mixed', 'Complete mixing'],
  ['twoComp', 'Two compartments'],
  ['fifo', 'Plug flow, first in first out'],
  ['lifo', 'Stacked plug flow, last in first out'],
];

export function MixingEditor({ state, handles }: { state: AppState; handles: number[] }) {
  const doc = state.store.doc;
  const values = handles.map((h) => doc.get(h, 'mixing') as model.Mixing | null);
  const same = values.every((v) => JSON.stringify(v) === JSON.stringify(values[0]));
  const mix = same ? (values[0] ?? null) : undefined;
  const [error, setError] = useState<string | null>(null);
  const modelId = useId();
  const fracId = useId();
  const set = (next: model.Mixing | null) => setError(commit(state, handles, 'mixing', next) ?? null);
  return (
    <>
      <Row label="Mixing model" htmlFor={modelId} help="How water mixes inside the tank." error={error}>
        <select
          id={modelId}
          value={mix === undefined ? '\u0000' : (mix?.model ?? 'mixed')}
          onChange={(e) => {
            const m = e.target.value as model.MixModel;
            set(m === 'mixed' ? null : { model: m, fraction: m === 'twoComp' ? (mix?.fraction ?? 1) : 1 });
          }}
        >
          {mix === undefined && <option value={'\u0000'}>Mixed</option>}
          {MIX_MODELS.map(([m, label]) => (
            <option key={m} value={m}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      {mix?.model === 'twoComp' && (
        <Row
          label="Mixing fraction"
          htmlFor={fracId}
          help="Fraction of the tank's volume in the inlet and outlet compartment."
        >
          <CommitInput
            id={fracId}
            value={String(mix.fraction)}
            numeric
            onCommit={(t) => {
              const v = getfloat(t.trim());
              if (v === undefined || v <= 0 || v > 1)
                return 'The fraction must be more than 0 and at most 1.';
              set({ ...mix, fraction: v });
              return undefined;
            }}
            onError={setError}
          />
        </Row>
      )}
    </>
  );
}

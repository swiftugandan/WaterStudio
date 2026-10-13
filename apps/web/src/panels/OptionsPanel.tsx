/**
 * Project options: EPANET's hydraulic, demand, quality, reaction, time, energy and
 * report options and the title, from the catalogue in @waterstudio/core. An empty field
 * means EPANET's default, shown as the placeholder. Every change is one undoable edit.
 */

import {
  CRITERIA,
  CRITERION_LABEL,
  criteriaError,
  displayOption,
  getfloat,
  OPTION_SPECS,
  optionSpec,
  parseOption,
  qualityTokens,
  readOption,
  readQuality,
  unitLabel,
  writeOption,
  type Criterion,
  type OptionSpec,
  type QualityOption,
} from '@waterstudio/core';
import { useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import type { AppState } from '../app/state.ts';
import { CommitInput, InputRow, Row } from './fields.tsx';
import { builtIn, DEFAULT_KEYS, type DefaultKey } from '../app/defaults.ts';

const TABS = [
  ['hydraulics', 'Hydraulics', ['Hydraulics']],
  ['demands', 'Demands', ['Demands']],
  ['quality', 'Quality', ['Quality', 'Reactions']],
  ['times', 'Times', ['Times']],
  ['energy', 'Energy', ['Energy']],
  ['report', 'Report', ['Report']],
  ['criteria', 'Criteria', []],
  ['defaults', 'Defaults', []],
  ['title', 'Summary', []],
] as const;
type Tab = (typeof TABS)[number][0];

/** Apply an option change as one undoable edit. */
export function setOption(state: AppState, id: string, tokens: readonly string[] | null): void {
  const spec = optionSpec.get(id);
  if (!spec) return;
  const doc = state.store.doc;
  const before = doc.data[spec.section];
  const after = writeOption(before, id, tokens);
  if (after === before) return;
  state.store.transact(`Set ${spec.label.toLowerCase()}`, (tx) => tx.setDoc(spec.section, after));
}

function unitOf(state: AppState, spec: OptionSpec): string {
  if (!spec.quantity) return '';
  return unitLabel(spec.quantity === 'pressureSetting' ? 'pressure' : spec.quantity, state.units);
}

function SimpleOption({ state, spec }: { state: AppState; spec: OptionSpec }) {
  const id = useId();
  const section = state.store.doc.data[spec.section];
  const shown = displayOption(section, spec.id);
  const k = spec.kind;
  if (k.type === 'choice' || k.type === 'pattern') {
    const options =
      k.type === 'choice' ? k.choices : state.store.doc.data.patterns.map((p) => [p.id, p.id] as const);
    // A value the list does not know (an abbreviation, say) is shown as it is.
    const current =
      shown === undefined
        ? ''
        : (options.find(([v]) => v.toUpperCase() === shown.toUpperCase())?.[0] ?? shown);
    const fallback =
      spec.id === 'pressureUnits'
        ? state.units.si
          ? 'metres'
          : 'psi'
        : k.type === 'choice'
          ? k.choices.find(([v]) => v === spec.fallback)?.[1]
          : spec.fallback;
    return (
      <Row label={spec.label} help={spec.help} htmlFor={id} unit={unitOf(state, spec)}>
        <select
          id={id}
          value={current}
          onChange={(e) => setOption(state, spec.id, e.target.value ? [e.target.value] : null)}
        >
          <option value="">{fallback ? `Default (${fallback})` : 'Default'}</option>
          {current !== '' && !options.some(([v]) => v === current) && (
            <option value={current}>{current}</option>
          )}
          {options.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </Row>
    );
  }
  return (
    <InputRow
      label={spec.label}
      help={spec.help}
      unit={unitOf(state, spec)}
      value={shown ?? ''}
      placeholder={spec.fallback}
      numeric={k.type === 'number'}
      onCommit={(text) => {
        const p = parseOption(spec.id, text);
        if (!p.ok) return p.error;
        setOption(state, spec.id, p.tokens);
        return undefined;
      }}
    />
  );
}

function QualityEditor({ state }: { state: AppState }) {
  const options = state.store.doc.data.options;
  const q = readQuality(options);
  const [error, setError] = useState<string | null>(null);
  const kindId = useId();
  const apply = (next: QualityOption) => {
    const p = qualityTokens(next);
    if (!p.ok) return p.error;
    setError(null);
    setOption(state, 'quality', p.tokens);
    return undefined;
  };
  const spec = optionSpec.get('quality')!;
  return (
    <>
      <Row label={spec.label} help={spec.help} htmlFor={kindId} error={error}>
        <select
          id={kindId}
          value={q.kind}
          onChange={(e) => {
            const kind = e.target.value as QualityOption['kind'];
            const next: QualityOption =
              kind === 'chemical'
                ? { kind, name: 'Chlorine', units: 'mg/L' }
                : kind === 'trace'
                  ? { kind, node: firstSource(state) }
                  : { kind };
            setError(apply(next) ?? null);
          }}
        >
          <option value="none">None</option>
          <option value="chemical">Chemical</option>
          <option value="age">Water age</option>
          <option value="trace">Source trace</option>
        </select>
      </Row>
      {q.kind === 'chemical' && (
        <>
          <InputRow
            label="Chemical name"
            help="Name shown in reports. Leave empty for “Chemical”."
            value={q.name}
            placeholder="Chemical"
            onCommit={(t) => apply({ ...q, name: t })}
          />
          <InputRow
            label="Concentration units"
            help="mg/L or ug/L. Needs a chemical name."
            value={q.units}
            placeholder="mg/L"
            onCommit={(t) =>
              q.name.trim() === '' && t.trim() !== ''
                ? 'Give the chemical a name first.'
                : apply({ ...q, units: t })
            }
          />
        </>
      )}
      {q.kind === 'trace' && (
        <InputRow
          label="Trace node"
          help="The node whose water is traced through the network."
          value={q.node}
          onCommit={(t) => {
            if (state.store.doc.findNode(t.trim()) === undefined) return `There is no node ${t.trim()}.`;
            return apply({ kind: 'trace', node: t });
          }}
        />
      )}
    </>
  );
}

/** The first reservoir or tank, as a sensible node to trace. */
function firstSource(state: AppState): string {
  const doc = state.store.doc;
  for (const h of doc.nodeHandles()) if (doc.nodeKind(h) !== 'junction') return doc.id(h);
  const first = doc.nodeHandles().next();
  return first.done ? '' : doc.id(first.value);
}

function UnbalancedEditor({ state }: { state: AppState }) {
  const spec = optionSpec.get('unbalanced')!;
  const v = readOption(state.store.doc.data.options, 'unbalanced');
  const cont = v?.[0]?.toUpperCase().startsWith('CONT') ?? false;
  const id = useId();
  return (
    <>
      <Row label={spec.label} help={spec.help} htmlFor={id}>
        <select
          id={id}
          value={cont ? 'CONTINUE' : 'STOP'}
          onChange={(e) =>
            setOption(state, 'unbalanced', e.target.value === 'STOP' ? null : ['CONTINUE', '10'])
          }
        >
          <option value="STOP">Stop</option>
          <option value="CONTINUE">Continue</option>
        </select>
      </Row>
      {cont && (
        <InputRow
          label="Extra trials"
          help="Trials to continue for with link status fixed (0 means stop once the maximum is reached)."
          value={v?.[1] ?? '0'}
          numeric
          onCommit={(t) => {
            if (!/^\d+$/.test(t.trim())) return 'Extra trials must be a whole number.';
            setOption(state, 'unbalanced', ['CONTINUE', t.trim()]);
            return undefined;
          }}
        />
      )}
    </>
  );
}

function ReportedEditor({ state, id }: { state: AppState; id: 'reportNodes' | 'reportLinks' }) {
  const spec = optionSpec.get(id)!;
  const v = readOption(state.store.doc.data.report, id) ?? ['NONE'];
  const mode =
    v.length === 1 && /^none$/i.test(v[0]!)
      ? 'NONE'
      : v.length === 1 && /^all$/i.test(v[0]!)
        ? 'ALL'
        : 'SOME';
  const selectId = useId();
  const listId = useId();
  const [error, setError] = useState<string | null>(null);
  const nodes = id === 'reportNodes';
  const doc = state.store.doc;
  return (
    <>
      <Row label={spec.label} help={spec.help} htmlFor={selectId}>
        <select
          id={selectId}
          value={mode}
          onChange={(e) => {
            const m = e.target.value;
            if (m === 'SOME') {
              const sel = [...state.selection]
                .filter((h) => doc.has(h) && doc.isNode(h) === nodes)
                .map((h) => doc.id(h));
              if (sel.length === 0) {
                setError(`Select the ${nodes ? 'nodes' : 'links'} to report on the map first.`);
                return;
              }
              setError(null);
              setOption(state, id, sel);
            } else setOption(state, id, m === 'NONE' ? null : ['ALL']);
          }}
        >
          <option value="NONE">None</option>
          <option value="ALL">All</option>
          <option value="SOME">Selected {nodes ? 'nodes' : 'links'}</option>
        </select>
      </Row>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      {mode === 'SOME' && (
        <Row label={nodes ? 'Node IDs' : 'Link IDs'} htmlFor={listId}>
          <CommitInput
            id={listId}
            value={v.join(' ')}
            onCommit={(t) => {
              const ids = t.split(/\s+/).filter(Boolean);
              const missing = ids.find((x) => (nodes ? doc.findNode(x) : doc.findLink(x)) === undefined);
              if (missing) return `There is no ${nodes ? 'node' : 'link'} ${missing}.`;
              setOption(state, id, ids.length ? ids : null);
              return undefined;
            }}
          />
        </Row>
      )}
    </>
  );
}

function TitleEditor({ state }: { state: AppState }) {
  const title = state.store.doc.data.title;
  const [text, setText] = useState(title.join('\n'));
  const [seen, setSeen] = useState(title);
  if (seen !== title) {
    setSeen(title);
    setText(title.join('\n'));
  }
  return (
    <div className="options-title">
      <label htmlFor="opt-title">Title and notes</label>
      <textarea
        id="opt-title"
        rows={8}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const lines = text.split('\n').map((l) => l.trimEnd());
          while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
          if (lines.join('\n') === title.join('\n')) return;
          state.store.transact('Edit title', (tx) => tx.setDoc('title', lines));
        }}
      />
      <p className="muted">EPANET shows the first three lines as the title of its reports.</p>
      <Summary state={state} />
    </div>
  );
}

/** EPANET's project summary: what the network holds and how it will be analysed. */
function Summary({ state }: { state: AppState }) {
  const doc = state.store.doc;
  const count: Record<string, number> = { junction: 0, reservoir: 0, tank: 0, pipe: 0, pump: 0, valve: 0 };
  for (const h of doc.nodeHandles()) count[doc.nodeKind(h)]!++;
  for (const h of doc.linkHandles()) count[doc.linkKind(h)]!++;
  const u = state.units;
  const d = doc.data;
  const q = readQuality(d.options);
  const rows: [string, string][] = [
    ['Junctions', String(count['junction'])],
    ['Reservoirs', String(count['reservoir'])],
    ['Tanks', String(count['tank'])],
    ['Pipes', String(count['pipe'])],
    ['Pumps', String(count['pump'])],
    ['Valves', String(count['valve'])],
    ['Patterns, curves', `${d.patterns.length}, ${d.curves.length}`],
    ['Controls, rules', `${d.controls.length}, ${d.rules.length}`],
    ['Flow units', u.flow],
    ['Headloss formula', u.headloss],
    ['Demand multiplier', displayOption(d.options, 'demandMultiplier') ?? '1'],
    ['Demand model', displayOption(d.options, 'demandModel') ?? 'DDA'],
    [
      'Quality analysis',
      q.kind === 'none'
        ? 'None'
        : q.kind === 'age'
          ? 'Water age'
          : q.kind === 'trace'
            ? `Trace from ${q.node}`
            : q.name || 'Chemical',
    ],
    ['Duration', displayOption(d.times, 'duration') ?? '0:00'],
    ['Hydraulic time step', displayOption(d.times, 'hydraulicStep') ?? '1:00'],
    ['Reporting time step', displayOption(d.times, 'reportStep') ?? '1:00'],
  ];
  return (
    <section className="results-values" aria-label="Project summary">
      <h3>Summary</h3>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

const DEFAULT_LABELS: Record<DefaultKey, [string, Parameters<typeof unitLabel>[0]]> = {
  junctionElevation: ['Junction elevation', 'elevation'],
  tankElevation: ['Tank elevation', 'elevation'],
  tankDiameter: ['Tank diameter', 'tankDiameter'],
  tankInitLevel: ['Tank initial level', 'level'],
  tankMaxLevel: ['Tank maximum level', 'level'],
  pipeLength: ['Pipe length', 'length'],
  pipeDiameter: ['Pipe diameter', 'diameter'],
  pipeRoughness: ['Pipe roughness', 'roughness'],
};

/** Project › Defaults: ID prefixes and starting values for new elements. */
function DefaultsEditor({ state }: { state: AppState }) {
  const d = state.defaults;
  return (
    <>
      <section className="field-group" aria-label="ID prefixes">
        <h3>ID prefixes</h3>
        {(Object.keys(d.prefixes) as (keyof typeof d.prefixes)[]).map((k) => (
          <InputRow
            key={k}
            label={`${k[0]!.toUpperCase()}${k.slice(1)}`}
            help="New elements of this type are numbered after this prefix."
            value={d.prefixes[k]}
            placeholder="None"
            onCommit={(t) => {
              const v = t.trim();
              if (/[\s;"]/.test(v)) return 'A prefix cannot contain spaces, semicolons or quotes.';
              state.setDefaults({ ...d, prefixes: { ...d.prefixes, [k]: v } });
              return undefined;
            }}
          />
        ))}
      </section>
      <section className="field-group" aria-label="Properties of new elements">
        <h3>Properties of new elements</h3>
        {DEFAULT_KEYS.map((k) => {
          const [label, q] = DEFAULT_LABELS[k];
          return (
            <InputRow
              key={k}
              label={label}
              unit={unitLabel(q, state.units)}
              numeric
              value={d.values[k] === undefined ? '' : String(d.values[k])}
              placeholder={String(builtIn(k, state.units))}
              onCommit={(t) => {
                const values: typeof d.values = Object.fromEntries(
                  Object.entries(d.values).filter(([key]) => key !== k),
                );
                if (t.trim() !== '') {
                  const n = getfloat(t.trim());
                  if (n === undefined) return `${label} must be a number.`;
                  if (
                    n < 0 ||
                    (n === 0 && k !== 'junctionElevation' && k !== 'tankElevation' && k !== 'tankInitLevel')
                  )
                    return `${label} must be more than 0.`;
                  values[k] = n;
                }
                state.setDefaults({ ...d, values });
                return undefined;
              }}
            />
          );
        })}
        <p className="muted">
          Remembered in this browser. Empty fields use the values shown, which follow the model’s units.
        </p>
      </section>
    </>
  );
}

const CRITERION_HELP: Record<Criterion, string> = {
  minPressure: 'Lowest pressure any junction may have at any report time.',
  maxPressure: 'Highest pressure any junction may have at any report time.',
  maxVelocity: 'Highest flow velocity in any pipe.',
  maxHeadloss: 'Highest unit head loss in any pipe.',
  minResidual: 'Lowest disinfectant concentration at any junction (with a chemical quality analysis).',
  maxAge: 'Highest water age at any junction (with a water age analysis).',
};

/**
 * Project › Criteria: the design criteria a design is checked against, by people
 * (Find violations, an agent's check) and by the independent checker of proposals.
 */
function CriteriaEditor({ state }: { state: AppState }) {
  const c = state.store.doc.data.criteria;
  const u = state.units;
  const quality = readQuality(state.store.doc.data.options);
  const unit: Record<Criterion, string> = {
    minPressure: unitLabel('pressure', u),
    maxPressure: unitLabel('pressure', u),
    maxVelocity: unitLabel('velocity', u),
    maxHeadloss: u.si ? 'm/km' : 'ft/kft',
    minResidual: quality.kind === 'chemical' && quality.units ? quality.units : '',
    maxAge: 'h',
  };
  return (
    <section className="field-group" aria-label="Design criteria">
      <h3>Design criteria</h3>
      {CRITERIA.map((k) => (
        <InputRow
          key={k}
          label={CRITERION_LABEL[k]}
          help={CRITERION_HELP[k]}
          {...(unit[k] ? { unit: unit[k] } : {})}
          numeric
          value={c[k] === null ? '' : String(c[k])}
          placeholder="Not checked"
          onCommit={(t) => {
            const text = t.trim();
            let v: number | null = null;
            if (text !== '') {
              const n = getfloat(text);
              if (n === undefined) return `${CRITERION_LABEL[k]} must be a number.`;
              v = n;
            }
            if (v === c[k]) return undefined;
            const next = { ...c, [k]: v };
            const error = criteriaError(next);
            if (error) return error;
            state.store.transact(`Set ${CRITERION_LABEL[k].toLowerCase()}`, (tx) =>
              tx.setDoc('criteria', next),
            );
            return undefined;
          }}
        />
      ))}
      <p className="muted">
        Leave a limit empty to not check it. Saved with the project, not in the .inp file. Agents check their
        proposals against these limits, and an independent check runs on every proposal.
      </p>
    </section>
  );
}

function Group({ state, group }: { state: AppState; group: string }) {
  return (
    <section className="field-group" aria-label={group}>
      <h3>{group}</h3>
      {OPTION_SPECS.filter((s) => s.group === group).map((s) => {
        if (s.id === 'quality') return <QualityEditor key={s.id} state={state} />;
        if (s.id === 'unbalanced') return <UnbalancedEditor key={s.id} state={state} />;
        if (s.id === 'reportNodes' || s.id === 'reportLinks')
          return <ReportedEditor key={s.id} state={state} id={s.id} />;
        return <SimpleOption key={s.id} state={state} spec={s} />;
      })}
    </section>
  );
}

export function OptionsPanel() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>('hydraulics');
  const current = TABS.find(([id]) => id === tab)!;
  return (
    <div className="panel options">
      <div className="panel-toolbar">
        <div className="segmented" role="tablist" aria-label="Option groups">
          {TABS.map(([id, label]) => (
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
      <div className="options-body" role="tabpanel" aria-label={current[1]}>
        {tab === 'title' ? (
          <TitleEditor state={state} />
        ) : tab === 'defaults' ? (
          <DefaultsEditor state={state} />
        ) : tab === 'criteria' ? (
          <CriteriaEditor state={state} />
        ) : (
          current[2].map((g) => <Group key={g} state={state} group={g} />)
        )}
      </div>
    </div>
  );
}

/**
 * The review queue: changes agents have proposed, each with its rationale, the engine's
 * before-and-after figures and every change it makes. The engineer accepts all of it or
 * some of it (one undoable step), rejects it, or sends it back with a comment. Nothing
 * an agent does reaches the model any other way.
 */

import {
  touchedIds,
  type ChangeItem,
  type CheckReport,
  type Kpis,
  type Proposal,
  type Verdict,
} from '@waterstudio/agents';
import {
  CRITERION_LABEL,
  linkField,
  nodeField,
  unitLabel,
  type FieldSpec,
  type UnitSystem,
} from '@waterstudio/core';
import { loadSettings } from '../app/assistant.ts';
import { useEffect, useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { openFilePicker } from '../app/files.ts';
import type { AppState } from '../app/state.ts';

const STATUS: Record<Proposal['status'], string> = {
  pending: 'to review',
  accepted: 'accepted',
  partial: 'partly accepted',
  rejected: 'rejected',
  returned: 'sent back',
};

function spec(it: Extract<ChangeItem, { op: 'set' }>): FieldSpec | undefined {
  return (it.table === 'node' ? nodeField : linkField).get(it.field);
}

/** A stored value as the inspector would show it. */
function show(v: unknown, s: FieldSpec | undefined): string {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '—';
  if (s?.editor.type === 'enum' && typeof v === 'number') return s.editor.options[v] ?? String(v);
  if (typeof v === 'number') return String(Number(v.toPrecision(6)));
  if (typeof v === 'string') return v;
  const text = JSON.stringify(v);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

function describe(it: ChangeItem, units: UnitSystem): { change: string; element: string; detail: string } {
  switch (it.op) {
    case 'add':
      return { change: 'Add', element: `${it.kind} ${it.id}`, detail: '' };
    case 'delete':
      return { change: 'Delete', element: `${it.kind} ${it.id}`, detail: '' };
    case 'set': {
      const s = spec(it);
      const unit = s && s.quantity !== 'none' ? ` ${unitLabel(s.quantity, units)}` : '';
      return {
        change: 'Change',
        element: `${it.kind} ${it.id}`,
        detail: `${s?.label ?? it.field}: ${show(it.from, s)} → ${show(it.to, s)}${unit}`,
      };
    }
    case 'doc':
      return { change: 'Replace', element: it.key, detail: '' };
  }
}

const KPI_ROWS: { key: keyof Kpis; label: string; unit: (u: UnitSystem) => string }[] = [
  { key: 'minPressure', label: 'Lowest junction pressure', unit: (u) => unitLabel('pressure', u) },
  { key: 'maxPressure', label: 'Highest junction pressure', unit: (u) => unitLabel('pressure', u) },
  { key: 'negativePressureJunctions', label: 'Junctions with negative pressure', unit: () => '' },
  { key: 'maxVelocity', label: 'Highest pipe velocity', unit: (u) => unitLabel('velocity', u) },
  { key: 'totalDemand', label: 'Total demand (first period)', unit: (u) => u.flow },
  { key: 'warning', label: 'Warning', unit: () => '' },
];

function Evidence({ p, units }: { p: Proposal; units: UnitSystem }) {
  const { before, after, errors } = p.evidence;
  const cell = (k: Kpis | null, key: keyof Kpis) => {
    const v = k?.[key];
    return v === null || v === undefined ? '—' : String(v);
  };
  return (
    <>
      <table className="chart-table proposal-kpis">
        <caption>Engine results before and after</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Before</th>
            <th scope="col">After</th>
          </tr>
        </thead>
        <tbody>
          {KPI_ROWS.map((r) => {
            const unit = r.unit(units);
            const changed = cell(before, r.key) !== cell(after, r.key);
            return (
              <tr key={r.key} className={changed ? 'changed' : undefined}>
                <th scope="row">
                  {r.label}
                  {unit && <span className="muted"> ({unit})</span>}
                </th>
                <td>{cell(before, r.key)}</td>
                <td>{cell(after, r.key)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {errors.map((e, i) => (
        <p key={i} className="field-error">
          {e}
        </p>
      ))}
    </>
  );
}

const VERDICT: Record<Verdict, string> = { pass: 'Passes', concerns: 'Concerns', fail: 'Fails' };
const REVIEW: Record<NonNullable<CheckReport['review']>['verdict'], string> = {
  approve: 'approves',
  concerns: 'has concerns',
  reject: 'rejects',
};

/**
 * The independent checker's report: the changes applied to the network as it is now,
 * solved and checked against the design criteria (ADR 0021), and, when asked for, a
 * second assistant's review.
 */
function Check({ state, p }: { state: AppState; p: Proposal }) {
  const c = p.check;
  const busy = state.checking.has(p.id);
  const settings = loadSettings();
  const canReview = !!settings.apiKey;
  const rows = (c?.after ?? c?.before)?.checked ?? [];
  return (
    <section className="proposal-check" aria-label="Independent check">
      <h4>
        Independent check{' '}
        <span aria-live="polite">
          {busy ? (
            <span className="verdict checking">Checking…</span>
          ) : (
            c && <span className={`verdict ${c.verdict}`}>{VERDICT[c.verdict]}</span>
          )}
        </span>
      </h4>
      <p className="muted">
        The changes applied to the network as it is now, solved and checked against the design criteria in
        Options, without the agent’s reasoning.
      </p>
      {c && (
        <>
          {c.findings.length > 0 && (
            <ul className="check-findings">
              {c.findings.map((f, i) => (
                <li key={i} className={f.severity}>
                  {f.text}
                </li>
              ))}
            </ul>
          )}
          {rows.length > 0 && (
            <table className="chart-table">
              <caption>Elements outside each design criterion</caption>
              <thead>
                <tr>
                  <th scope="col">Criterion</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const n = (a: CheckReport['before']) =>
                    a?.checked.find((x) => x.criterion === r.criterion)?.elements ?? '—';
                  return (
                    <tr key={r.criterion}>
                      <th scope="row">
                        {CRITERION_LABEL[r.criterion]} <span className="muted">({r.limit})</span>
                      </th>
                      <td>{n(c.before)}</td>
                      <td>{n(c.after)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {c.review && (
            <p className="check-review">
              <strong>
                {c.review.author} {REVIEW[c.review.verdict]}:
              </strong>{' '}
              {c.review.notes}
            </p>
          )}
        </>
      )}
      {p.evidence.unmet && p.evidence.unmet.length > 0 && (
        <div className="check-unmet">
          <p>The agent says these criteria cannot be met:</p>
          <ul>
            {p.evidence.unmet.map((u) => (
              <li key={u.criterion}>
                <strong>{CRITERION_LABEL[u.criterion]}:</strong> {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="row">
        <button type="button" className="btn" disabled={busy} onClick={() => void state.checkProposal(p.id)}>
          Check again
        </button>
        <button
          type="button"
          className="btn"
          disabled={busy || !c || !canReview}
          title={canReview ? undefined : 'Set up the assistant (with a key) to ask a second one.'}
          onClick={() => void state.reviewProposal(p.id, settings)}
        >
          Ask a second assistant
        </button>
      </div>
    </section>
  );
}

function Detail({ state, p }: { state: AppState; p: Proposal }) {
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [comment, setComment] = useState('');
  const [outcome, setOutcome] = useState<string | null>(null);
  const commentId = useId();
  const units = state.units;
  const pending = p.status === 'pending';
  const chosen = p.items.length - skip.size;

  useEffect(() => {
    setSkip(new Set());
    setComment('');
    setOutcome(null);
  }, [p.id]);

  const showOnMap = () => {
    const doc = state.store.doc;
    const ids = touchedIds(p.items);
    const handles = [
      ...[...ids.node].map((id) => doc.findNode(id)),
      ...[...ids.link].map((id) => doc.findLink(id)),
    ].filter((h): h is number => h !== undefined);
    state.select(handles);
    if (handles.length > 0) state.view?.zoomTo(handles);
  };

  return (
    <section className="proposal-detail" aria-label={`Proposal ${p.id}`}>
      <h3>
        {p.id}: {p.title}
      </h3>
      <p className="muted">
        {p.author} · {new Date(p.created).toLocaleTimeString()} · {STATUS[p.status]}
      </p>
      <p className="proposal-rationale">{p.rationale}</p>
      {p.comment && (
        <p>
          <strong>Your comment:</strong> {p.comment}
        </p>
      )}
      <Evidence p={p} units={units} />
      <Check state={state} p={p} />
      <table className="chart-table proposal-items">
        <caption>
          {p.items.length} {p.items.length === 1 ? 'change' : 'changes'}
        </caption>
        <thead>
          <tr>
            <th scope="col">Apply</th>
            <th scope="col">Change</th>
            <th scope="col">Element</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {p.items.map((it, i) => {
            const d = describe(it, units);
            return (
              <tr key={i} className={`op-${it.op}`}>
                <td>
                  <input
                    type="checkbox"
                    aria-label={`Apply change ${i + 1}: ${d.change} ${d.element}`}
                    checked={!skip.has(i)}
                    disabled={!pending}
                    onChange={(e) => {
                      const next = new Set(skip);
                      if (e.target.checked) next.delete(i);
                      else next.add(i);
                      setSkip(next);
                    }}
                  />
                </td>
                <td>{d.change}</td>
                <td>{d.element}</td>
                <td>{d.detail}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button type="button" className="btn" onClick={showOnMap}>
          Show on map
        </button>
      </div>
      {pending && (
        <>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              disabled={chosen === 0}
              onClick={() => {
                const r = state.acceptProposal(p.id, (i) => !skip.has(i));
                if (r)
                  setOutcome(
                    `Applied ${r.applied} ${r.applied === 1 ? 'change' : 'changes'}` +
                      (r.conflicts.length > 0
                        ? `; ${r.conflicts.length} had changed since and were skipped (see Messages).`
                        : '. Undo reverts them in one step.'),
                  );
              }}
            >
              {chosen === p.items.length ? 'Accept all' : `Accept ${chosen} of ${p.items.length}`}
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => state.closeProposal(p.id, 'rejected', comment)}
            >
              Reject
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => state.closeProposal(p.id, 'returned', comment)}
            >
              Send back
            </button>
          </div>
          <label htmlFor={commentId}>Comment for the agent (with Reject or Send back)</label>
          <textarea id={commentId} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </>
      )}
      {outcome && (
        <p role="status" className="proposal-outcome">
          {outcome}
        </p>
      )}
    </section>
  );
}

function OpenFile({ state }: { state: AppState }) {
  const [error, setError] = useState<string | null>(null);
  const open = async () => {
    const f = await openFilePicker('.json,application/json');
    if (!f) return;
    try {
      state.loadProposals(await f.text(), f.name);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <>
      <button type="button" className="btn" onClick={() => void open()}>
        Open proposals file
      </button>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function ProposalsPanel() {
  const { state } = useApp();
  const list = state.proposals;
  const [picked, setPicked] = useState<string | null>(null);
  const current =
    list.find((p) => p.id === picked) ?? list.findLast((p) => p.status === 'pending') ?? list.at(-1);
  const pending = list.filter((p) => p.status === 'pending').length;

  if (list.length === 0) {
    return (
      <div className="panel proposals">
        <p className="muted proposals-empty">
          No proposals yet. In the Assistant, let the agent propose changes: it edits a draft copy of the
          network and its proposals wait here for you to review. Nothing reaches the network until you accept
          it. Proposals an agent made through the MCP server are in a file beside the network.
        </p>
        <div className="panel-toolbar">
          <OpenFile state={state} />
        </div>
      </div>
    );
  }
  return (
    <div className="panel proposals">
      <div className="panel-toolbar">
        <span className="muted" aria-live="polite">
          {pending} to review, {list.length} in all
        </span>
        <span className="spacer" />
        <OpenFile state={state} />
      </div>
      <ul className="proposal-list" aria-label="Proposals">
        {list.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              className={`proposal-row${current?.id === p.id ? ' picked' : ''}`}
              aria-current={current?.id === p.id ? 'true' : undefined}
              onClick={() => setPicked(p.id)}
            >
              <span>
                {p.id}: {p.title}
              </span>
              <span className={`proposal-status ${p.status}`}>
                {STATUS[p.status]}
                {p.check && p.status === 'pending' && p.check.verdict !== 'pass'
                  ? ` · ${VERDICT[p.check.verdict].toLowerCase()} the check`
                  : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {current && <Detail state={state} p={current} />}
    </div>
  );
}

/**
 * The pipe sizing study (ADR 0022): least-cost standard sizes for the pipes chosen,
 * against the design criteria and, for fire-flow repair, a fire flow at every junction.
 * The result is a table of changes that can be sent to Proposals for review.
 */

import { CRITERION_LABEL, getfloat, hour, unitLabel, type Criterion } from '@waterstudio/core';
import type { SizingBreach } from '@waterstudio/engine-client';
import { useId, useState } from 'react';
import { copyText, tsv } from '../app/files.ts';
import { defaultSizes, parseSizes, proposeSizing, runSizing, type SizingRun } from '../app/sizing.ts';
import type { AppState } from '../app/state.ts';

const HYDRAULIC: Criterion[] = ['minPressure', 'maxPressure', 'maxVelocity', 'maxHeadloss'];

const BREACH: Record<SizingBreach['kind'], string> = {
  ...CRITERION_LABEL,
  fireResidual: 'Residual pressure at a hydrant',
  fireSystem: 'Pressure elsewhere during a fire',
};

const n = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const money = (v: number) => Math.round(v).toLocaleString('en-US');

function Breaches({ title, list, total }: { title: string; list: SizingBreach[]; total: number }) {
  if (total === 0) return null;
  const kinds = new Map<string, number>();
  for (const b of list) kinds.set(b.kind, (kinds.get(b.kind) ?? 0) + 1);
  return (
    <p className="muted">
      {title}: {total} element{total === 1 ? '' : 's'} outside a limit, worst{' '}
      {list
        .slice(0, 3)
        .map((b) => `${b.id} (${BREACH[b.kind].toLowerCase()} ${n(b.value)} against ${b.limit})`)
        .join(', ')}
      .
    </p>
  );
}

export function SizingStudy({ state }: { state: AppState }) {
  const u = state.units;
  const doc = state.store.doc;
  const criteria = doc.data.criteria;
  const set = HYDRAULIC.filter((k) => criteria[k] !== null);
  const [which, setWhich] = useState<'all' | 'selected'>('all');
  const [useCriteria, setUseCriteria] = useState(true);
  const [useFire, setUseFire] = useState(false);
  const [fire, setFire] = useState({
    flow: u.si ? '60' : '1000',
    residual: u.si ? '14' : '20',
    systemMin: u.si ? '14' : '20',
    time: '0:00',
  });
  const [sizesText, setSizesText] = useState(() => defaultSizes(u.si));
  const [asNew, setAsNew] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<SizingRun | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const ids = {
    which: useId(),
    crit: useId(),
    fire: useId(),
    flow: useId(),
    res: useId(),
    sys: useId(),
    time: useId(),
    sizes: useId(),
    sizesHelp: useId(),
    asNew: useId(),
  };
  const isPipe = (h: number) => doc.isLink(h) && doc.kind(h) === 'pipe';
  const pipes =
    which === 'all'
      ? [...doc.linkHandles()].filter(isPipe).map((h) => doc.id(h))
      : [...state.selection].filter((h) => doc.has(h) && isPipe(h)).map((h) => doc.id(h));
  const dUnit = unitLabel('diameter', u);
  const lUnit = unitLabel('length', u);
  const flowUnit = unitLabel('flow', u);
  const pUnit = unitLabel('pressure', u);
  const stale = run !== null && run.rev !== state.store.rev;

  const start = () => {
    const sizes = parseSizes(sizesText);
    if (typeof sizes === 'string') {
      setError(sizes);
      return;
    }
    if (pipes.length === 0) {
      setError('Select pipes to size, or size every pipe.');
      return;
    }
    if (!useCriteria && !useFire) {
      setError('Size for the design criteria, a fire flow, or both.');
      return;
    }
    if (useCriteria && set.length === 0 && !useFire) {
      setError('No pressure, velocity or head loss criteria are set; set them in Options, Criteria.');
      return;
    }
    let fireOptions = null;
    if (useFire) {
      const flow = getfloat(fire.flow.trim());
      const residual = getfloat(fire.residual.trim());
      const systemMin = fire.systemMin.trim() === '' ? undefined : getfloat(fire.systemMin.trim());
      const [a = '', b = ''] = fire.time.trim().split(/\s+/);
      const t = hour(a, b);
      if (flow === undefined || flow <= 0) {
        setError('The fire flow must be a number above 0.');
        return;
      }
      if (residual === undefined) {
        setError('The residual pressure must be a number.');
        return;
      }
      if (fire.systemMin.trim() !== '' && systemMin === undefined) {
        setError('The system minimum must be a number.');
        return;
      }
      if (t < 0) {
        setError('Enter the time of day as h:mm.');
        return;
      }
      fireOptions = {
        flow,
        residual,
        time: Math.round(t * 3600),
        ...(systemMin !== undefined ? { systemMin } : {}),
      };
    }
    setError(null);
    setSent(null);
    setBusy(true);
    setProgress(useFire ? 'Testing fire flow at every junction…' : 'Sizing…');
    void runSizing(
      state,
      { pipes, sizes, criteria: useCriteria && set.length > 0, fire: fireOptions, asNew },
      (d, total) => {
        setProgress(d < total ? `Testing fire flow: ${d} of ${total} junctions…` : 'Sizing…');
      },
    )
      .then((r) => setRun(r))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        setBusy(false);
        setProgress(null);
      });
  };

  const send = () => {
    if (!run) return;
    setBusy(true);
    void proposeSizing(state, run)
      .then((id) => setSent(id))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const result = run?.result ?? null;
  const select = (list: string[]) =>
    state.select(list.flatMap((id) => (doc.findLink(id) !== undefined ? [doc.findLink(id)!] : [])));

  return (
    <>
      <form
        className="query-grid"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label htmlFor={ids.which}>Pipes</label>
        <select id={ids.which} value={which} onChange={(e) => setWhich(e.target.value as 'all' | 'selected')}>
          <option value="all">Every pipe</option>
          <option value="selected">Selected pipes</option>
        </select>
        <span className="label">Size for</span>
        <label className="check" htmlFor={ids.crit}>
          <input
            id={ids.crit}
            type="checkbox"
            checked={useCriteria}
            onChange={(e) => setUseCriteria(e.target.checked)}
          />
          <span>
            Design criteria
            {set.length > 0
              ? ` (${set.map((k) => `${CRITERION_LABEL[k].toLowerCase()} ${criteria[k]}`).join(', ')})`
              : ' (none set: Options, Criteria)'}
          </span>
        </label>
        <span />
        <label className="check" htmlFor={ids.fire}>
          <input
            id={ids.fire}
            type="checkbox"
            checked={useFire}
            onChange={(e) => setUseFire(e.target.checked)}
          />
          <span>Fire flow at every junction</span>
        </label>
        {useFire &&
          (
            [
              ['flow', ids.flow, 'Fire flow', flowUnit],
              ['residual', ids.res, 'Residual pressure', pUnit],
              ['systemMin', ids.sys, 'System minimum', pUnit],
              ['time', ids.time, 'Time of day', 'h:mm'],
            ] as const
          ).map(([key, id, label, unit]) => (
            <FireField
              key={key}
              id={id}
              label={label}
              unit={unit}
              value={fire[key]}
              onChange={(v) => setFire({ ...fire, [key]: v })}
            />
          ))}
        <label htmlFor={ids.sizes}>Sizes and costs</label>
        <textarea
          id={ids.sizes}
          className="sizes-input"
          aria-describedby={ids.sizesHelp}
          rows={5}
          spellCheck={false}
          value={sizesText}
          onChange={(e) => setSizesText(e.target.value)}
        />
        <span />
        <p id={ids.sizesHelp} className="muted">
          One size per line: diameter ({dUnit}) and installed cost per {lUnit}.
        </p>
        <span />
        <label className="check" htmlFor={ids.asNew}>
          <input
            id={ids.asNew}
            type="checkbox"
            checked={asNew}
            onChange={(e) => setAsNew(e.target.checked)}
          />
          <span>Size as new pipes (from the smallest size, every pipe costed)</span>
        </label>
        <span />
        <button type="submit" className="btn primary" disabled={busy}>
          {busy && !run ? 'Sizing…' : `Size ${pipes.length} pipe${pipes.length === 1 ? '' : 's'}`}
        </button>
      </form>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="muted" role="status">
        {progress ??
          (run?.note
            ? run.note
            : result
              ? `${result.meets ? 'Every limit is met' : 'Not every limit can be met'}: ${result.changes.length} pipe${
                  result.changes.length === 1 ? '' : 's'
                } resized for ${money(result.cost)}, ${result.solutions} solutions.` +
                (result.stopped ? ` ${result.stopped}` : '') +
                (sent ? ` Sent to Proposals as ${sent}.` : '')
              : '')}
      </p>
      {stale && <p className="muted">The network has changed since this study; run it again to send it.</p>}
      {run && run.hydrants.length > 0 && (
        <p className="muted">
          Sized for fire flow at {run.hydrants.length} junction{run.hydrants.length === 1 ? '' : 's'} that
          fell short: {run.hydrants.slice(0, 12).join(', ')}
          {run.hydrants.length > 12 ? '…' : ''}.
        </p>
      )}
      {result && (
        <>
          <Breaches title="Before" list={result.before} total={result.breachesBefore} />
          <Breaches title="After" list={result.after} total={result.breachesAfter} />
          {result.changes.length > 0 && (
            <>
              <div className="row">
                <button type="button" className="btn" onClick={() => select(result.changes.map((c) => c.id))}>
                  Select resized pipes ({result.changes.length})
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    void copyText(
                      tsv([
                        ['Pipe', `Length (${lUnit})`, `From (${dUnit})`, `To (${dUnit})`, 'Cost'],
                        ...result.changes.map((c) => [
                          c.id,
                          n(c.length, 1),
                          String(c.from),
                          String(c.to),
                          money(c.cost),
                        ]),
                      ]),
                    )
                  }
                >
                  Copy
                </button>
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy || stale || sent !== null}
                  onClick={send}
                >
                  Send to Proposals
                </button>
              </div>
              <div className="chart-table-wrap">
                <table className="chart-table studies-table">
                  <caption className="sr-only">Pipes resized by the study</caption>
                  <thead>
                    <tr>
                      <th scope="col">Pipe</th>
                      <th scope="col">Length ({lUnit})</th>
                      <th scope="col">From ({dUnit})</th>
                      <th scope="col">To ({dUnit})</th>
                      <th scope="col">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.changes.map((c) => (
                      <tr key={c.id} onClick={() => select([c.id])}>
                        <th scope="row">{c.id}</th>
                        <td>{n(c.length, 1)}</td>
                        <td>{c.from}</td>
                        <td>{c.to}</td>
                        <td>{money(c.cost)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

function FireField(props: {
  id: string;
  label: string;
  unit: string;
  value: string;
  onChange(v: string): void;
}) {
  return (
    <>
      <label htmlFor={props.id}>{props.label}</label>
      <span className="field-control">
        <input
          id={props.id}
          type="text"
          inputMode={props.unit === 'h:mm' ? 'text' : 'decimal'}
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
        />
        {props.unit && <span className="unit">{props.unit}</span>}
      </span>
    </>
  );
}

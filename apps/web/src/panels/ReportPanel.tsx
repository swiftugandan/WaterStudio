/**
 * EPANET's reports: the hydraulic status log, pump energy, average reaction rates and
 * the full text report, made by the engine exactly as runepanet makes them. Both the
 * report and the binary output file can be downloaded.
 */

import { readOutFile, type OutFileSummary } from '@waterstudio/engine-client';
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { saveBinaryFile, saveTextFile } from '../app/files.ts';
import type { AppState, FilesState } from '../app/state.ts';
import { CalibrationReport } from './CalibrationReport.tsx';

type Tab = 'status' | 'energy' | 'reaction' | 'calibration' | 'full';
const TABS: [Tab, string][] = [
  ['status', 'Status'],
  ['energy', 'Energy'],
  ['reaction', 'Reaction'],
  ['calibration', 'Calibration'],
  ['full', 'Full report'],
];

/** The status log within a report: from its header to the end of the analysis. */
export function statusSection(report: string): string {
  const lines = report.split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('Hydraulic Status:'));
  if (start < 0) return '';
  let end = lines.findIndex((l, i) => i > start && l.trim().startsWith('Analysis ended'));
  if (end < 0) end = lines.length;
  return lines
    .slice(start, end)
    .map((l) => l.replace(/^ {2}/, ''))
    .join('\n')
    .trimEnd();
}

function baseName(name: string): string {
  return name.replace(/\.inp$/i, '');
}

function useFiles(state: AppState, which: 'report' | 'status' | null): FilesState | undefined {
  const f = which ? state.files[which] : undefined;
  useEffect(() => {
    if (which) void state.loadFiles(which);
  }, [state, which, state.store.rev]);
  return f;
}

function Pending({ f }: { f: FilesState | undefined }) {
  if (!f || f.status === 'running') return <p className="panel-empty">Running the analysis…</p>;
  return (
    <p className="panel-empty" role="alert">
      The analysis failed: {f.error}
    </p>
  );
}

function Energy({ state, out, f }: { state: AppState; out: OutFileSummary; f: FilesState }) {
  const doc = state.store.doc;
  if (out.energy.length === 0) return <p className="panel-empty">This network has no pumps.</p>;
  const perVolume = state.units.si ? 'kWh/m³' : 'kWh/Mgal';
  const total = out.energy.reduce((a, e) => a + e.costPerDay, 0);
  const n2 = (v: number) => v.toFixed(2);
  return (
    <table className="report-table">
      <caption>Energy usage</caption>
      <thead>
        <tr>
          <th scope="col">Pump</th>
          <th scope="col">Utilization (%)</th>
          <th scope="col">Avg. efficiency (%)</th>
          <th scope="col">{perVolume}</th>
          <th scope="col">Avg. kW</th>
          <th scope="col">Peak kW</th>
          <th scope="col">Cost / day</th>
        </tr>
      </thead>
      <tbody>
        {out.energy.map((e) => {
          const h = f.links?.[e.link];
          return (
            <tr key={e.link}>
              <th scope="row">{h !== undefined && doc.has(h) ? doc.id(h) : `#${e.link + 1}`}</th>
              <td>{n2(e.utilization)}</td>
              <td>{n2(e.efficiency)}</td>
              <td>{n2(e.kwhPerVolume)}</td>
              <td>{n2(e.averageKw)}</td>
              <td>{n2(e.peakKw)}</td>
              <td>{n2(e.costPerDay)}</td>
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" colSpan={6}>
            Demand charge
          </th>
          <td>{n2(out.demandCharge)}</td>
        </tr>
        <tr>
          <th scope="row" colSpan={6}>
            Total cost
          </th>
          <td>{n2(total + out.demandCharge)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

function Reaction({ state, out }: { state: AppState; out: OutFileSummary }) {
  const q = state.units.quality;
  if (q.kind !== 'chemical') {
    return <p className="panel-empty">Reaction rates apply to a chemical quality analysis.</p>;
  }
  const mass = q.units.replace(/\/\s*L$/i, '') || 'mass';
  const { bulk, wall, tank, source } = out.reactions;
  const total = bulk + wall + tank;
  const rows: [string, number][] = [
    ['Bulk (pipes)', bulk],
    ['Wall (pipes)', wall],
    ['Tanks', tank],
  ];
  const fmt = (v: number) =>
    Math.abs(v) >= 1e5 || (v !== 0 && Math.abs(v) < 0.01) ? v.toExponential(3) : v.toFixed(2);
  return (
    <table className="report-table">
      <caption>Average reaction rates ({mass}/hr)</caption>
      <thead>
        <tr>
          <th scope="col">Where</th>
          <th scope="col">Rate</th>
          <th scope="col">Share</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, v]) => (
          <tr key={label}>
            <th scope="row">{label}</th>
            <td>{fmt(v)}</td>
            <td>
              <span className="share">
                <span className="share-bar" style={{ width: `${total > 0 ? (v / total) * 100 : 0}%` }} />
                {total > 0 ? `${((v / total) * 100).toFixed(1)}%` : '—'}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">Total reaction</th>
          <td>{fmt(total)}</td>
          <td />
        </tr>
        <tr>
          <th scope="row">Mass inflow from sources</th>
          <td>{fmt(source)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}

export function ReportPanel() {
  const { state } = useApp();
  const [tab, setTab] = useState<Tab>('status');
  const which = tab === 'status' ? 'status' : tab === 'calibration' ? null : 'report';
  const f = useFiles(state, which);
  const files = f?.status === 'done' ? f.files : undefined;
  const out = useMemo(() => {
    try {
      return files ? readOutFile(files.out) : undefined;
    } catch {
      return undefined;
    }
  }, [files]);
  const name = baseName(state.fileName);

  let body;
  if (tab === 'calibration') body = <CalibrationReport state={state} />;
  else if (!files) body = <Pending f={f} />;
  else if (tab === 'status') {
    const log = statusSection(files.report);
    body = log ? <pre className="report-text">{log}</pre> : <p className="panel-empty">No status log.</p>;
  } else if (tab === 'full') body = <pre className="report-text">{files.report}</pre>;
  else if (!out) body = <p className="panel-empty">The output file could not be read.</p>;
  else if (tab === 'energy') body = <Energy state={state} out={out} f={f!} />;
  else body = <Reaction state={state} out={out} />;

  return (
    <div className="panel report">
      <div className="panel-toolbar">
        <div className="segmented" role="tablist" aria-label="Report">
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
        <span className="spacer" />
        {tab !== 'calibration' && (
          <>
            <button
              type="button"
              className="btn"
              disabled={!files}
              onClick={() => files && saveTextFile(files.report, `${name}.rpt`)}
            >
              Download .rpt
            </button>
            <button
              type="button"
              className="btn"
              disabled={!files}
              onClick={() => files && saveBinaryFile(files.out, `${name}.out`)}
            >
              Download .out
            </button>
          </>
        )}
      </div>
      <div
        className="report-body"
        role="tabpanel"
        aria-label={TABS.find(([id]) => id === tab)![1]}
        tabIndex={0}
      >
        {body}
      </div>
    </div>
  );
}

/**
 * The calibration report: load measurements for a variable (EPANET's .dat format) and
 * compare them with the simulation, per location and for the whole network, with a
 * plot of computed against observed values.
 */

import { linkSeries, nodeSeries } from '@waterstudio/engine-client';
import { useId, useState } from 'react';
import {
  CALIBRATION_VARIABLES,
  calibrationReport,
  isLinkVariable,
  parseCalibration,
  type CalibrationVariable,
} from '../app/calibration.ts';
import { openFilePicker } from '../app/files.ts';
import { hours } from '../app/graphs.ts';
import type { AppState } from '../app/state.ts';
import { LineChart } from '../charts/LineChart.tsx';
import { variableLabel } from '../shell/Ribbon.tsx';
import { variableUnit } from '../viewport/paint.ts';

const f3 = (v: number) => (Number.isFinite(v) ? v.toFixed(3) : '–');

export function CalibrationReport({ state }: { state: AppState }) {
  const loaded = CALIBRATION_VARIABLES.filter((v) => state.calibration[v]);
  const [variable, setVariable] = useState<CalibrationVariable>(loaded[0] ?? 'pressure');
  const [issues, setIssues] = useState<string[]>([]);
  const selectId = useId();
  const data = state.calibration[variable];
  const r = state.run;
  const doc = state.store.doc;
  const unit = variableUnit(variable, state.units);

  const load = async () => {
    const file = await openFilePicker('.dat,.txt,.csv');
    if (!file) return;
    const parsed = parseCalibration(await file.text());
    setIssues(parsed.issues);
    state.setCalibration(variable, { fileName: file.name, observations: parsed.observations });
  };

  let report = null;
  if (data && r.status === 'done' && r.results && r.nodes && r.links) {
    const results = r.results;
    const link = isLinkVariable(variable);
    const handles = link ? r.links : r.nodes;
    const rep = calibrationReport(data.observations, hours(results), (location) => {
      const h = link ? doc.findLink(location) : doc.findNode(location);
      if (h === undefined) return null;
      const col = handles.indexOf(h);
      if (col < 0) return null;
      return link ? linkSeries(results, variable, col) : nodeSeries(results, variable, col);
    });
    const all = rep.pairs.flatMap((p) => [p.observed, p.computed]);
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    report = (
      <>
        <table className="chart-table calibration-table">
          <caption>
            {variableLabel(variable)} calibration{unit ? ` (${unit})` : ''}: {data.fileName}
          </caption>
          <thead>
            <tr>
              <th scope="col">Location</th>
              <th scope="col">Observations</th>
              <th scope="col">Observed mean</th>
              <th scope="col">Computed mean</th>
              <th scope="col">Mean error</th>
              <th scope="col">RMS error</th>
            </tr>
          </thead>
          <tbody>
            {rep.rows.map((row) => (
              <tr key={row.location}>
                <th scope="row">{row.location}</th>
                <td>{row.n}</td>
                <td>{f3(row.observedMean)}</td>
                <td>{f3(row.computedMean)}</td>
                <td>{f3(row.meanError)}</td>
                <td>{f3(row.rmsError)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Network</th>
              <td>{rep.network.n}</td>
              <td>{f3(rep.network.observedMean)}</td>
              <td>{f3(rep.network.computedMean)}</td>
              <td>{f3(rep.network.meanError)}</td>
              <td>{f3(rep.network.rmsError)}</td>
            </tr>
          </tfoot>
        </table>
        <p>
          Correlation between means:{' '}
          <strong>{rep.correlation === null ? '–' : rep.correlation.toFixed(3)}</strong>
        </p>
        {(rep.unknown.length > 0 || rep.outside > 0) && (
          <p className="muted" role="status">
            {rep.unknown.length > 0 &&
              `No ${link ? 'link' : 'node'} called ${rep.unknown.slice(0, 5).join(', ')}${rep.unknown.length > 5 ? '…' : ''}. `}
            {rep.outside > 0 && `${rep.outside} observations fall outside the simulated period.`}
          </p>
        )}
        {rep.pairs.length > 0 && (
          <div className="calibration-chart">
            <LineChart
              title={`Computed and observed ${variableLabel(variable).toLowerCase()}`}
              xLabel={`Observed${unit ? ` (${unit})` : ''}`}
              yLabel={`Computed${unit ? ` (${unit})` : ''}`}
              series={[
                {
                  name: 'Measurements',
                  x: rep.pairs.map((p) => p.observed),
                  y: rep.pairs.map((p) => p.computed),
                  dots: true,
                  line: false,
                },
                { name: 'Perfect agreement', x: [lo, hi], y: [lo, hi] },
              ]}
            />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="calibration">
      <div className="panel-toolbar">
        <label htmlFor={selectId}>Variable</label>
        <select
          id={selectId}
          value={variable}
          onChange={(e) => setVariable(e.target.value as CalibrationVariable)}
        >
          {CALIBRATION_VARIABLES.map((v) => (
            <option key={v} value={v}>
              {variableLabel(v)}
              {state.calibration[v] ? ' (loaded)' : ''}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={() => void load()}>
          Load measurements…
        </button>
        {data && (
          <button type="button" className="btn" onClick={() => state.setCalibration(variable, null)}>
            Remove
          </button>
        )}
      </div>
      {issues.length > 0 && (
        <ul className="field-error" role="alert">
          {issues.slice(0, 5).map((i) => (
            <li key={i}>{i}</li>
          ))}
          {issues.length > 5 && <li>and {issues.length - 5} more lines that could not be read</li>}
        </ul>
      )}
      {!data ? (
        <p className="panel-empty">
          Load measured {variableLabel(variable).toLowerCase()} values: one “location time value” per line, as
          EPANET’s calibration files have them.
        </p>
      ) : r.status !== 'done' ? (
        <p className="panel-empty">Run the analysis to compare the measurements with the simulation.</p>
      ) : (
        report
      )}
    </div>
  );
}

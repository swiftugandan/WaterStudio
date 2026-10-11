import { EngineClient, type HydraulicReport } from '@waterstudio/engine-client';
import { HydraulicIcon } from '@waterstudio/ui';
import { useEffect, useMemo, useRef, useState } from 'react';

const SAMPLES = [
  { file: 'Net1.inp', label: 'Net1: chlorine decay, 11 junctions, 1 tank, 1 pump' },
  { file: 'Net2.inp', label: 'Net2: fluoride tracer, 35 junctions, 1 tank' },
  { file: 'Net3.inp', label: 'Net3: two sources, 92 junctions, 3 tanks, 2 pumps' },
] as const;

type State =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; report: HydraulicReport; solveMs: number; file: string }
  | { kind: 'error'; message: string };

function clock(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

const fmt = new Intl.NumberFormat('en', { maximumFractionDigits: 3, minimumFractionDigits: 3 });

export function EngineDemo() {
  const client = useRef<EngineClient | null>(null);
  const [sample, setSample] = useState<string>(SAMPLES[0].file);
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [period, setPeriod] = useState(0);

  useEffect(() => {
    client.current = new EngineClient({ workers: 1 });
    return () => client.current?.dispose();
  }, []);

  async function run() {
    setState({ kind: 'running' });
    try {
      const res = await fetch(`/samples/${sample}`);
      if (!res.ok) throw new Error(`could not load ${sample} (${res.status})`);
      const inp = await res.text();
      if (!client.current) throw new Error('engine not started');
      const { report, solveMs } = await client.current.runHydraulics(inp);
      setPeriod(0);
      setState({ kind: 'done', report, solveMs, file: sample });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }

  const rows = useMemo(() => {
    if (state.kind !== 'done') return [];
    const r = state.report;
    return r.nodes.map((id, i) => ({
      id,
      head: r.heads[period]?.[i] ?? NaN,
      demand: r.demands[period]?.[i] ?? NaN,
    }));
  }, [state, period]);

  return (
    <section className="card" aria-labelledby="engine-h">
      <h2 id="engine-h">
        <HydraulicIcon name="run-hydraulics" size={20} /> Engine
      </h2>
      <p className="muted">
        Solve one of EPANET's example networks over its whole duration, in a worker, with the same engine the
        app will ship.
      </p>
      <div className="toolbar">
        <label className="field">
          <span>Network</span>
          <select value={sample} onChange={(e) => setSample(e.target.value)}>
            {SAMPLES.map((s) => (
              <option key={s.file} value={s.file}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          onClick={() => void run()}
          disabled={state.kind === 'running'}
        >
          <HydraulicIcon name="run-hydraulics" size={16} />
          {state.kind === 'running' ? 'Solving…' : 'Run hydraulics'}
        </button>
      </div>

      <div role="status" aria-live="polite" className="status">
        {state.kind === 'error' && <span className="error">Engine error: {state.message}</span>}
        {state.kind === 'done' && (
          <span data-testid="engine-summary">
            Solved {state.file}: {state.report.nodes.length} nodes, {state.report.links.length} links,{' '}
            {state.report.heads.length} report periods in {state.solveMs.toFixed(1)} ms ({state.report.engine}
            ).
          </span>
        )}
      </div>

      {state.kind === 'done' && (
        <>
          <label className="field slider">
            <span>
              Report time{' '}
              <output data-testid="period-time">
                {clock(state.report.report_start + period * state.report.report_step)}
              </output>
            </span>
            <input
              type="range"
              min={0}
              max={state.report.heads.length - 1}
              value={period}
              onChange={(e) => setPeriod(Number(e.target.value))}
            />
          </label>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Node results">
            <table className="data" data-testid="node-table">
              <caption className="sr-only">Node heads and demands at the selected report time</caption>
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col" className="num">
                    Head
                  </th>
                  <th scope="col" className="num">
                    Demand
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <th scope="row">{r.id}</th>
                    <td className="num">{fmt.format(r.head)}</td>
                    <td className="num">{fmt.format(r.demand)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

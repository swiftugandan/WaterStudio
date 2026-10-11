/**
 * Multi-species water quality (EPANET-MSX): the MSX input edited as text in its own
 * syntax, a run of the hydraulics and the MSX analysis, the species it reports (shown
 * on the map, in graphs and tables like any result) and the MSX report.
 */

import { speciesVariable, type SpeciesInfo } from '@waterstudio/engine-client';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../app/context.tsx';
import { openFilePicker, saveTextFile } from '../app/files.ts';
import type { AppState } from '../app/state.ts';

type Tab = 'input' | 'species' | 'report';

/** A starting point: chlorine decay in the bulk flow and at the pipe wall. */
export const MSX_TEMPLATE = `[TITLE]
Chlorine decay

[OPTIONS]
AREA_UNITS  FT2
RATE_UNITS  DAY
SOLVER      RK5
TIMESTEP    300
RTOL        0.001
ATOL        0.001

[SPECIES]
BULK  CL2  MG  0.01  0.001   ;free chlorine

[COEFFICIENTS]
PARAMETER  Kb  0.3           ;bulk decay (1/day)
PARAMETER  Kw  1.0           ;wall decay (ft/day)

[TERMS]
Kf  1.5826e-4 * Re^0.88 / D  ;mass transfer coefficient

[PIPES]
RATE  CL2  -Kb*CL2 - (4/D)*Kw*Kf/(Kw+Kf)*CL2

[TANKS]
RATE  CL2  -Kb*CL2

[QUALITY]
GLOBAL  CL2  0.5

[REPORT]
SPECIES  CL2  YES
`;

const SECTIONS = [
  '[TITLE]  a title line',
  '[OPTIONS]  AREA_UNITS FT2|M2|CM2, RATE_UNITS SEC|MIN|HR|DAY, SOLVER EUL|RK5|ROS2, COUPLING NONE|FULL,',
  '           TIMESTEP seconds, RTOL value, ATOL value, SEGMENTS n, PECLET value',
  '[SPECIES]  BULK|WALL  id  units  (atol  rtol)',
  '[COEFFICIENTS]  PARAMETER|CONSTANT  id  value',
  '[TERMS]  id  expression',
  '[PIPES] and [TANKS]  RATE|EQUIL|FORMULA  species  expression',
  '[SOURCES]  CONC|MASS|SETPOINT|FLOW  node  species  strength  (pattern)',
  '[QUALITY]  GLOBAL species value | NODE node species value | LINK link species value',
  '[PARAMETERS]  PIPE pipe parameter value | TANK tank parameter value',
  '[PATTERNS]  id  multipliers ...',
  '[DIFFUSIVITY]  species  relative diffusivity  (FIXED)',
  '[REPORT]  NODES ids|ALL, LINKS ids|ALL, SPECIES id YES|NO (precision), PAGESIZE n',
  'Hydraulic variables in expressions: D diameter, Q flow, U velocity, Re Reynolds number, Us shear velocity,',
  'Ff friction factor, Av area per volume, Kc roughness, Len length. Functions: abs sgn sqrt log exp log10',
  'step sin cos tan cot asin acos atan acot sinh cosh tanh coth, and ^ for powers.',
];

/** The line number an MSX error message points at, if any. */
function errorLine(text: string): number | null {
  const m = /at line (\d+) of/.exec(text);
  return m ? Number(m[1]) : null;
}

function useElapsed(started: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (started === undefined) return;
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [started]);
  return started === undefined ? 0 : Math.max(0, now - started);
}

async function openMsx(state: AppState): Promise<void> {
  const file = await openFilePicker('.msx,.txt');
  if (!file) return;
  state.setMsx({ name: file.name, text: await file.text() });
}

export function MsxPanel() {
  const { state } = useApp();
  const input = state.store.doc.data.msx;
  const [tab, setTab] = useState<Tab>('input');
  const [draft, setDraft] = useState<string | null>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const msx = state.msxRun;
  const running = msx.status === 'running';
  const elapsed = useElapsed(running ? msx.started : undefined);
  const results = state.run.status === 'done' ? state.run.results : undefined;
  const species = results?.msx?.species ?? [];
  const text = draft ?? input?.text ?? '';
  const dirty = draft !== null && input !== null && draft !== input.text;

  // A new MSX input (opened or undone) replaces the draft.
  useEffect(() => setDraft(null), [input]);

  const apply = () => {
    if (input && dirty) state.setMsx({ ...input, text }, 'Edit MSX input');
    setDraft(null);
  };
  const run = () => {
    apply();
    void state.runMsx();
  };
  const goToLine = (line: number) => {
    const ta = editor.current;
    if (!ta) return;
    setTab('input');
    const lines = ta.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((n, l) => n + l.length + 1, 0);
    const end = start + (lines[line - 1]?.length ?? 0);
    ta.focus();
    ta.setSelectionRange(start, end);
  };

  const toolbar = (
    <div className="panel-toolbar">
      <div className="segmented" role="tablist" aria-label="Multi-species view">
        {(
          [
            ['input', 'Input'],
            ['species', `Species${species.length ? ` (${species.length})` : ''}`],
            ['report', 'Report'],
          ] as const
        ).map(([id, label]) => (
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
      <button type="button" className="btn" onClick={() => void openMsx(state)}>
        Open…
      </button>
      {input && (
        <button
          type="button"
          className="btn"
          onClick={() => saveTextFile(text, input.name || 'network.msx')}
          title="Save the MSX input as a file"
        >
          Save…
        </button>
      )}
      {running ? (
        <button type="button" className="btn" onClick={() => state.stopMsx()}>
          Stop ({Math.floor(elapsed / 1000)} s)
        </button>
      ) : (
        <button type="button" className="btn primary" disabled={!input} onClick={run}>
          Run MSX
        </button>
      )}
    </div>
  );

  let body;
  if (tab === 'input') {
    body = !input ? (
      <div className="panel-empty msx-empty">
        <p>
          EPANET-MSX models several interacting species in the bulk water and on pipe walls. Its input is a
          file of its own beside the network.
        </p>
        <p>
          <button type="button" className="btn" onClick={() => void openMsx(state)}>
            Open an .msx file
          </button>{' '}
          <button
            type="button"
            className="btn"
            onClick={() => state.setMsx({ name: 'network.msx', text: MSX_TEMPLATE }, 'New MSX input')}
          >
            Start from a template
          </button>
        </p>
      </div>
    ) : (
      <>
        <div className="msx-file">
          <span className="muted">{input.name}</span>
          <span className="spacer" />
          <button type="button" className="btn" disabled={!dirty} onClick={() => setDraft(null)}>
            Revert
          </button>
          <button type="button" className="btn" disabled={!dirty} onClick={apply}>
            Apply
          </button>
          <button type="button" className="btn" onClick={() => state.setMsx(null)}>
            Remove
          </button>
        </div>
        <textarea
          ref={editor}
          className="code-editor"
          aria-label="EPANET-MSX input"
          spellCheck={false}
          value={text}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              run();
            }
          }}
        />
        <details className="syntax-help">
          <summary>Syntax</summary>
          <pre>{SECTIONS.join('\n')}</pre>
        </details>
      </>
    );
  } else if (tab === 'species') {
    body =
      species.length === 0 ? (
        <p className="panel-empty">Run MSX to see the species here.</p>
      ) : (
        <SpeciesTable state={state} species={species} />
      );
  } else {
    const report = results?.msx?.report ?? '';
    body = !results?.msx ? (
      <p className="panel-empty">Run MSX to see its report.</p>
    ) : report ? (
      <>
        <div className="msx-file">
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={() =>
              saveTextFile(report, (input?.name ?? 'network.msx').replace(/\.[^.]*$/, '') + '.rpt')
            }
          >
            Save report…
          </button>
        </div>
        <pre className="report-text msx-report" tabIndex={0} aria-label="MSX report">
          {report}
        </pre>
      </>
    ) : (
      <p className="panel-empty">
        The MSX input asks for no report: list nodes or links and species in its [REPORT] section.
      </p>
    );
  }

  return (
    <div className="panel msx-panel">
      {toolbar}
      {running && (
        <p className="muted" role="status">
          Running the hydraulics and the MSX analysis…
        </p>
      )}
      {msx.status === 'error' && msx.error && (
        <div className="field-error msx-errors" role="alert">
          {msx.error.split('\n').map((line, i) => {
            const at = errorLine(line);
            return at !== null && input ? (
              <button key={i} type="button" className="link-button" onClick={() => goToLine(at)}>
                {line}
              </button>
            ) : (
              <div key={i}>{line}</div>
            );
          })}
        </div>
      )}
      {body}
    </div>
  );
}

function SpeciesTable({ state, species }: { state: AppState; species: SpeciesInfo[] }) {
  const doc = state.store.doc;
  const theme = state.mapTheme;
  const selected = (table: 'node' | 'link') =>
    [...state.selection].filter((h) => doc.has(h) && (table === 'node' ? doc.isNode(h) : doc.isLink(h)));
  const graph = (s: SpeciesInfo) => {
    const v = speciesVariable(s.id);
    const nodes = s.kind === 'bulk' ? selected('node') : [];
    if (nodes.length > 0)
      state.openGraph({ kind: 'series', table: 'node', variable: v, ids: nodes.map((h) => doc.id(h)) });
    else
      state.openGraph({
        kind: 'series',
        table: 'link',
        variable: v,
        ids: selected('link').map((h) => doc.id(h)),
      });
  };
  return (
    <table className="report-table msx-species">
      <caption>Species of the last MSX run</caption>
      <thead>
        <tr>
          <th scope="col">Species</th>
          <th scope="col">Type</th>
          <th scope="col">Units</th>
          <th scope="col">Show</th>
        </tr>
      </thead>
      <tbody>
        {species.map((s) => {
          const v = speciesVariable(s.id);
          return (
            <tr key={s.id}>
              <th scope="row">{s.id}</th>
              <td>{s.kind === 'bulk' ? 'Bulk' : 'Wall'}</td>
              <td>{s.units}</td>
              <td className="msx-actions">
                {s.kind === 'bulk' && (
                  <button
                    type="button"
                    className="btn"
                    aria-pressed={theme.node === v}
                    onClick={() => state.setMapTheme({ node: theme.node === v ? null : v })}
                  >
                    Nodes
                  </button>
                )}
                <button
                  type="button"
                  className="btn"
                  aria-pressed={theme.link === v}
                  onClick={() => state.setMapTheme({ link: theme.link === v ? null : v })}
                >
                  Links
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={state.selection.size === 0}
                  title="Graph this species over time at the selected elements"
                  onClick={() => graph(s)}
                >
                  Graph
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

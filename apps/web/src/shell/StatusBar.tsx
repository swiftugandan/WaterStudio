import { useEffect, useState } from 'react';
import { useApp } from '../app/context.tsx';

export function StatusBar() {
  const { state } = useApp();
  const [cursor, setCursor] = useState<[number, number] | null>(null);
  // The cursor moves too often to re-render the app; poll it gently.
  useEffect(() => {
    const id = setInterval(() => setCursor(state.cursor), 100);
    return () => clearInterval(id);
  }, [state]);
  const doc = state.store.doc;
  const u = state.units;
  const r = state.renderer;
  const run = state.run;
  return (
    <footer className="statusbar" aria-label="Status">
      <span>
        {state.fileName}
        {state.dirty ? ' •' : ''}
      </span>
      <span>
        {doc.nodes.liveCount} nodes · {doc.links.liveCount} links
      </span>
      {state.selection.size > 0 && <span>{state.selection.size} selected</span>}
      <span className="spacer" />
      <span className="mono">{cursor ? `${cursor[0].toFixed(2)}, ${cursor[1].toFixed(2)}` : '—'}</span>
      <span>
        {u.flow} · {u.headloss}
      </span>
      <span data-testid="run-status" className={`run ${run.status}${state.stale ? ' stale' : ''}`}>
        {run.status === 'running'
          ? 'Solving…'
          : run.status === 'done'
            ? state.stale
              ? 'Results out of date'
              : `Solved in ${run.ms?.toFixed(0) ?? '?'} ms`
            : run.status === 'error'
              ? 'Run failed'
              : 'Not run'}
      </span>
      <span data-testid="renderer" className="badge-renderer" title={r.note ?? r.error ?? ''}>
        {r.backend === 'webgpu' ? 'WebGPU' : r.backend === 'canvas2d' ? 'Canvas 2D' : 'Starting renderer…'}
      </span>
    </footer>
  );
}

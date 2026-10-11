import { useEffect, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { useApp } from '../app/context.tsx';

export function clock(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d > 0 ? `${d}d ` : ''}${h}:${String(m).padStart(2, '0')}`;
}

/** Report-time slider with play/pause; drives the map and every results view. */
export function TimeControl({ compact = false }: { compact?: boolean }) {
  const { state } = useApp();
  const r = state.run.results;
  const n = r?.times.length ?? 0;
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    if (!playing || n < 2) return;
    const id = setInterval(() => {
      state.setPeriod(state.period + 1 >= n ? 0 : state.period + 1);
    }, 400);
    return () => clearInterval(id);
  }, [playing, n, state]);

  const time = r ? r.reportStart + state.period * r.reportStep : 0;
  return (
    <div className={`time-control${compact ? ' compact' : ''}`}>
      <button
        type="button"
        className="icon-btn"
        disabled={n < 2}
        aria-label={playing ? 'Pause' : 'Play'}
        onClick={() => setPlaying((p) => !p)}
      >
        {playing ? <Pause size={16} aria-hidden="true" /> : <Play size={16} aria-hidden="true" />}
      </button>
      <input
        type="range"
        aria-label="Report time"
        min={0}
        max={Math.max(0, n - 1)}
        value={state.period}
        disabled={n < 2}
        onChange={(e) => state.setPeriod(Number(e.target.value))}
      />
      <output aria-label="Current report time" data-testid="report-time">
        {r ? clock(time) : '—'}
      </output>
    </div>
  );
}

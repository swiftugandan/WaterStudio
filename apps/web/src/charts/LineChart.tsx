/**
 * A line chart drawn as SVG with the app's tokens: nice axes, any number of series,
 * an optional marker at the current time, a crosshair readout on hover, and a data
 * table for screen readers and copying. Sizes itself to its container.
 */

import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { extent, niceTicks, tickLabel } from './scale.ts';

export interface Series {
  name: string;
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  /** Mark each point (for measured or entered points, rather than a continuous series). */
  dots?: boolean;
  /** Join the points with a line (default true). */
  line?: boolean;
}

export interface LineChartProps {
  title: string;
  series: Series[];
  xLabel: string;
  yLabel: string;
  /** Format an x value for the crosshair and table (defaults to the tick format). */
  xFormat?: (x: number) => string;
  /** Format x-axis ticks (defaults to plain numbers). */
  xTickFormat?: (x: number) => string;
  /** Draw a vertical marker at this x (the current report time). */
  marker?: number;
  /** Draw series as steps (held until the next point), as EPANET's time series do. */
  step?: boolean;
  /** Show the data as a table instead of the plot. */
  table?: boolean;
  /** Axis limits set by hand; anything left out follows the data. */
  range?: { xMin?: number; xMax?: number; yMin?: number; yMax?: number };
  /** Draw grid lines (default true). */
  grid?: boolean;
}

/** Nice ticks over the data, with any limit set by hand kept exactly. */
function axisTicks(data: [number, number], lo: number | undefined, hi: number | undefined, count: number) {
  const a = lo ?? data[0];
  const b = hi ?? data[1];
  const t = niceTicks(Math.min(a, b), Math.max(a, b), count);
  if (lo === undefined && hi === undefined) return t;
  const min = lo ?? t.min;
  const max = hi ?? t.max;
  if (!(max > min)) return t;
  return {
    ...t,
    min,
    max,
    values: t.values.filter((v) => v >= min - 1e-9 * t.step && v <= max + 1e-9 * t.step),
  };
}

const M = { left: 60, right: 26, top: 10, bottom: 38 };
const COLOURS = 6;

export function useSize(ref: React.RefObject<HTMLElement | null>): [number, number] {
  const [size, setSize] = useState<[number, number]>([600, 300]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([e]) => {
      if (!e) return;
      const { width, height } = e.contentRect;
      setSize([Math.max(200, width), Math.max(140, height)]);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function pathOf(s: Series, sx: (v: number) => number, sy: (v: number) => number, step: boolean): string {
  let d = '';
  let pen = false;
  for (let i = 0; i < s.x.length; i++) {
    const xv = s.x[i]!;
    const yv = s.y[i]!;
    if (!Number.isFinite(yv) || !Number.isFinite(xv)) {
      pen = false;
      continue;
    }
    const X = sx(xv).toFixed(1);
    const Y = sy(yv).toFixed(1);
    if (!pen) d += `M${X},${Y}`;
    else if (step) d += `H${X}V${Y}`;
    else d += `L${X},${Y}`;
    pen = true;
  }
  return d;
}

export function LineChart({
  title,
  series,
  xLabel,
  yLabel,
  xFormat,
  xTickFormat,
  marker,
  step = false,
  table = false,
  range,
  grid = true,
}: LineChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const [w, h] = useSize(box);
  const [hover, setHover] = useState<number | null>(null);
  const id = useId();

  const { xt, yt } = useMemo(() => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const s of series) {
      for (let i = 0; i < s.x.length; i++) xs.push(s.x[i]!);
      for (let i = 0; i < s.y.length; i++) ys.push(s.y[i]!);
    }
    return {
      xt: axisTicks(extent(xs), range?.xMin, range?.xMax, Math.max(2, Math.floor(w / 90))),
      yt: axisTicks(extent(ys), range?.yMin, range?.yMax, Math.max(2, Math.floor(h / 50))),
    };
  }, [series, w, h, range]);

  const pw = w - M.left - M.right;
  const ph = h - M.top - M.bottom;
  const sx = (v: number) => M.left + ((v - xt.min) / (xt.max - xt.min)) * pw;
  const sy = (v: number) => M.top + ph - ((v - yt.min) / (yt.max - yt.min)) * ph;
  const fx = xFormat ?? ((v: number) => tickLabel(v, xt.step));
  const fy = (v: number) => (Number.isFinite(v) ? tickLabel(v, yt.step / 10) : '—');

  // The x positions the crosshair snaps to: those of the first series.
  const xs = series[0]?.x;
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!xs || xs.length === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    let best = 0;
    for (let i = 1; i < xs.length; i++)
      if (Math.abs(sx(xs[i]!) - px) < Math.abs(sx(xs[best]!) - px)) best = i;
    setHover(best);
  };

  const summary = `${title}: ${series.length} series of ${yLabel} against ${xLabel}, from ${fy(yt.min)} to ${fy(yt.max)}.`;

  return (
    <figure className="chart" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="chart-title">
        {title}
      </figcaption>
      {series.length > 1 && (
        <ul className="chart-legend" aria-label="Series">
          {series.map((s, i) => (
            <li key={s.name}>
              <span className={`swatch c${(i % COLOURS) + 1}`} aria-hidden="true" />
              {s.name}
            </li>
          ))}
        </ul>
      )}
      {table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">{xLabel}</th>
                {series.map((s) => (
                  <th scope="col" key={s.name}>
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: xs?.length ?? 0 }, (_, i) => (
                <tr key={i}>
                  <th scope="row">{fx(xs![i]!)}</th>
                  {series.map((s) => (
                    <td key={s.name}>{fy(s.y[i] ?? NaN)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" ref={box}>
          <svg
            width={w}
            height={h}
            role="img"
            aria-label={summary}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <defs>
              <clipPath id={`${id}-clip`}>
                <rect x={M.left} y={M.top} width={Math.max(0, pw)} height={Math.max(0, ph)} />
              </clipPath>
            </defs>
            <g className="chart-grid" display={grid ? undefined : 'none'}>
              {yt.values.map((v) => (
                <line key={`y${v}`} x1={M.left} x2={M.left + pw} y1={sy(v)} y2={sy(v)} />
              ))}
              {xt.values.map((v) => (
                <line key={`x${v}`} y1={M.top} y2={M.top + ph} x1={sx(v)} x2={sx(v)} />
              ))}
            </g>
            <g className="chart-axis" aria-hidden="true">
              <line x1={M.left} x2={M.left + pw} y1={M.top + ph} y2={M.top + ph} />
              <line x1={M.left} x2={M.left} y1={M.top} y2={M.top + ph} />
              {yt.values.map((v) => (
                <text key={`yl${v}`} x={M.left - 6} y={sy(v)} textAnchor="end" dominantBaseline="middle">
                  {tickLabel(v, yt.step)}
                </text>
              ))}
              {xt.values.map((v) => (
                <text key={`xl${v}`} x={sx(v)} y={M.top + ph + 16} textAnchor="middle">
                  {xTickFormat ? xTickFormat(v) : tickLabel(v, xt.step)}
                </text>
              ))}
              <text x={M.left + pw / 2} y={h - 4} textAnchor="middle" className="chart-axis-label">
                {xLabel}
              </text>
              <text
                transform={`translate(12 ${M.top + ph / 2}) rotate(-90)`}
                textAnchor="middle"
                className="chart-axis-label"
              >
                {yLabel}
              </text>
            </g>
            {marker !== undefined && marker >= xt.min && marker <= xt.max && (
              <line className="chart-marker" x1={sx(marker)} x2={sx(marker)} y1={M.top} y2={M.top + ph} />
            )}
            <g clipPath={`url(#${id}-clip)`}>
              {series.map((s, i) =>
                s.line === false ? null : (
                  <path
                    key={s.name}
                    className={`chart-line c${(i % COLOURS) + 1}`}
                    d={pathOf(s, sx, sy, step)}
                  />
                ),
              )}
              {series.map(
                (s, i) =>
                  s.dots && (
                    <g key={`${s.name}-dots`} className={`chart-dots c${(i % COLOURS) + 1}`}>
                      {Array.from({ length: s.x.length }, (_, k) =>
                        Number.isFinite(s.x[k]) && Number.isFinite(s.y[k]) ? (
                          <circle key={k} cx={sx(s.x[k]!)} cy={sy(s.y[k]!)} r={3.5} />
                        ) : null,
                      )}
                    </g>
                  ),
              )}
            </g>
            {hover !== null && xs && (
              <line
                className="chart-cross"
                x1={sx(xs[hover]!)}
                x2={sx(xs[hover]!)}
                y1={M.top}
                y2={M.top + ph}
              />
            )}
          </svg>
          {hover !== null && xs && (
            <div
              className="chart-tip"
              style={{ left: Math.min(sx(xs[hover]!) + 10, w - 160), top: M.top }}
              aria-hidden="true"
            >
              <div className="chart-tip-x">{fx(xs[hover]!)}</div>
              {series.map((s, i) => (
                <div key={s.name}>
                  <span className={`swatch c${(i % COLOURS) + 1}`} />
                  {series.length > 1 ? `${s.name}: ` : ''}
                  {fy(s.y[hover] ?? NaN)}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

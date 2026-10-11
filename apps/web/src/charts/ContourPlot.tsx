/**
 * EPANET's contour plot: filled bands of a node variable over the network's plan, with
 * contour lines at the legend's breaks and the pipes drawn faintly on top. Colours and
 * breaks are the map's for the same variable, so the two read the same. The table view
 * lists each band's range and how many nodes fall in it.
 */

import { useId, useMemo, useRef } from 'react';
import { contours, edgeLimit, triangulate } from './contour.ts';
import { useSize } from './LineChart.tsx';
import { tickLabel } from './scale.ts';

export interface ContourPlotProps {
  title: string;
  unit: string;
  xs: Float64Array;
  ys: Float64Array;
  values: Float64Array;
  /** Link polylines as flat [x, y, ...] arrays in the same coordinates. */
  links: number[][];
  breaks: number[];
  colors: string[];
  table?: boolean;
}

const PAD = 12;
const LEGEND = 150;

function rangeLabel(breaks: number[], b: number, unit: string): string {
  const step = breaks.length > 1 ? Math.abs(breaks[1]! - breaks[0]!) / 10 : 0.01;
  const f = (v: number) => tickLabel(v, step || 0.01);
  const u = unit ? ` ${unit}` : '';
  if (breaks.length === 0) return 'All values';
  if (b === 0) return `Below ${f(breaks[0]!)}${u}`;
  if (b === breaks.length) return `${f(breaks[b - 1]!)}${u} and above`;
  return `${f(breaks[b - 1]!)} to ${f(breaks[b]!)}${u}`;
}

export function ContourPlot({
  title,
  unit,
  xs,
  ys,
  values,
  links,
  breaks,
  colors,
  table = false,
}: ContourPlotProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, h] = useSize(ref);
  const id = useId();

  const tri = useMemo(() => {
    const lengths = links.map((l) => {
      let d = 0;
      for (let i = 2; i < l.length; i += 2) d += Math.hypot(l[i]! - l[i - 2]!, l[i + 1]! - l[i - 1]!);
      return d;
    });
    return triangulate(xs, ys, edgeLimit(lengths));
  }, [xs, ys, links]);

  const counts = useMemo(() => {
    const c = new Array<number>(breaks.length + 1).fill(0);
    for (const v of values) {
      if (!Number.isFinite(v)) continue;
      let k = 0;
      while (k < breaks.length && v >= breaks[k]!) k++;
      c[k]!++;
    }
    return c;
  }, [values, breaks]);

  // Fit the plan into the drawing, keeping its aspect ratio; y grows upwards in the plan.
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    x0 = Math.min(x0, xs[i]!);
    x1 = Math.max(x1, xs[i]!);
    y0 = Math.min(y0, ys[i]!);
    y1 = Math.max(y1, ys[i]!);
  }
  const pw = Math.max(40, w - LEGEND - 2 * PAD);
  const ph = Math.max(40, h - 2 * PAD - 24);
  const scale = Math.min(pw / Math.max(x1 - x0, 1e-9), ph / Math.max(y1 - y0, 1e-9));
  const ox = PAD + (pw - (x1 - x0) * scale) / 2;
  const oy = PAD + (ph - (y1 - y0) * scale) / 2;
  const sx = (x: number) => ox + (x - x0) * scale;
  const sy = (y: number) => oy + (y1 - y) * scale;

  const drawn = useMemo(
    () => contours(xs, ys, values, tri, breaks, sx, sy),
    // sx and sy follow from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [xs, ys, values, tri, breaks, w, h],
  );
  const pipes = useMemo(
    () =>
      links
        .map((l) => {
          let d = '';
          for (let i = 0; i < l.length; i += 2)
            d += `${i === 0 ? 'M' : 'L'}${sx(l[i]!).toFixed(1)},${sy(l[i + 1]!).toFixed(1)}`;
          return d;
        })
        .join(''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [links, w, h],
  );

  return (
    <figure className="chart contour" aria-labelledby={`${id}-cap`}>
      <figcaption id={`${id}-cap`} className="chart-title">
        {title}
      </figcaption>
      {table ? (
        <div className="chart-table-wrap">
          <table className="chart-table">
            <caption className="sr-only">{title}</caption>
            <thead>
              <tr>
                <th scope="col">Band</th>
                <th scope="col">Nodes</th>
              </tr>
            </thead>
            <tbody>
              {counts.map((n, b) => (
                <tr key={b}>
                  <th scope="row">{rangeLabel(breaks, b, unit)}</th>
                  <td>{n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-plot" ref={ref}>
          <svg
            width={w}
            height={h}
            role="img"
            aria-label={`${title}. ${counts.map((n, b) => `${rangeLabel(breaks, b, unit)}: ${n} nodes`).join('; ')}.`}
          >
            {drawn.bands.map((d, b) =>
              d ? (
                <path
                  key={b}
                  d={d}
                  fill={colors[b] ?? colors[colors.length - 1]}
                  stroke={colors[b] ?? colors[colors.length - 1]}
                  strokeWidth={0.6}
                  strokeLinejoin="round"
                />
              ) : null,
            )}
            {drawn.lines.map((d, j) => (d ? <path key={j} className="contour-line" d={d} /> : null))}
            <path className="contour-pipes" d={pipes} />
            <g className="contour-legend" transform={`translate(${w - LEGEND + 8},${PAD})`}>
              {colors.map((c, b) => (
                <g key={b} transform={`translate(0,${(colors.length - 1 - b) * 22})`}>
                  <rect width={14} height={14} fill={c} rx={2} />
                  <text x={20} y={11}>
                    {rangeLabel(breaks, b, unit)}
                  </text>
                </g>
              ))}
            </g>
          </svg>
        </div>
      )}
    </figure>
  );
}

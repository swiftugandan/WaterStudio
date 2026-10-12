/**
 * Network tools: node elevations from a digital elevation model or online terrain,
 * and demand allocation (a total spread over junctions, or customer demands at points
 * assigned to the nearest junction or pipe). Each run is one undoable edit.
 */

import { unitLabel } from '@waterstudio/core';
import { readDem, rasterBounds, type Raster } from '@waterstudio/gis';
import { useId, useState } from 'react';
import { useApp } from '../app/context.tsx';
import {
  allocatePoints,
  allocateTotal,
  applyAllocation,
  junctions,
  parseDemandPoints,
  type DemandPoint,
  type PointMethod,
  type TotalMethod,
} from '../app/demands.ts';
import {
  applyElevations,
  demSampler,
  elevationTargets,
  heightFactor,
  planElevations,
} from '../app/elevations.ts';
import { openFilePicker } from '../app/files.ts';
import type { AppState } from '../app/state.ts';
import { modelCrs } from '../geo/model.ts';
import { fetchTerrainTile, sampleTerrain, TERRAIN_ATTRIBUTION } from '../geo/terrain.ts';

export type ToolsTab = 'elevations' | 'demands';

type Message = { ok: boolean; text: string } | null;

function listIds(ids: string[]): string {
  return ids.length <= 8 ? ids.join(', ') : `${ids.slice(0, 8).join(', ')} and ${ids.length - 8} more`;
}

export function ToolsPanel() {
  const { state } = useApp();
  const tab = state.toolsTab;
  return (
    <div className="panel tools-panel">
      <div className="panel-toolbar">
        <div className="segmented" role="tablist" aria-label="Network tool">
          {(
            [
              ['elevations', 'Elevations'],
              ['demands', 'Demand allocation'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? 'on' : undefined}
              onClick={() => state.setToolsTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      {tab === 'elevations' ? <Elevations state={state} /> : <Demands state={state} />}
    </div>
  );
}

function Scope({
  value,
  onChange,
  what,
}: {
  value: 'all' | 'selected';
  onChange: (v: 'all' | 'selected') => void;
  what: string;
}) {
  return (
    <label>
      <span>Apply to</span>
      <select value={value} onChange={(e) => onChange(e.target.value as 'all' | 'selected')}>
        <option value="all">Every {what}</option>
        <option value="selected">Selected {what}s</option>
      </select>
    </label>
  );
}

function Status({ message }: { message: Message }) {
  if (!message) return null;
  return (
    <p className={message.ok ? 'muted' : 'field-error'} role={message.ok ? 'status' : 'alert'}>
      {message.text}
    </p>
  );
}

function Elevations({ state }: { state: AppState }) {
  const id = useId();
  const [source, setSource] = useState<'file' | 'terrain'>('file');
  const [dem, setDem] = useState<{ name: string; raster: Raster } | null>(null);
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [onlyZero, setOnlyZero] = useState(false);
  const [demFeet, setDemFeet] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const doc = state.store.doc;
  const crs = modelCrs(doc);
  const unit = unitLabel('elevation', state.units);

  const chooseDem = async () => {
    const file = await openFilePicker('.tif,.tiff,.asc,.txt');
    if (!file) return;
    try {
      const raster = await readDem(file.name, await file.arrayBuffer());
      setDem({ name: file.name, raster });
      setMessage(null);
    } catch (e) {
      setMessage({ ok: false, text: `${file.name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const report = (n: number, outside: string[], from: string) => {
    const off = outside.length
      ? ` ${outside.length} nodes lie outside it or on missing data: ${listIds(outside)}.`
      : '';
    setMessage({
      ok: n > 0 || outside.length === 0,
      text: `Set the elevations of ${n} nodes from ${from}.${off}`,
    });
    if (n > 0) state.log('info', `Elevations of ${n} nodes set from ${from}.`);
  };

  const run = async () => {
    const opts = { scope, onlyZero, demFeet: source === 'file' && demFeet };
    const targets = elevationTargets(doc, state.selection, opts);
    if (targets.length === 0) {
      setMessage({ ok: false, text: 'No junctions or tanks to set: check what the tool applies to.' });
      return;
    }
    const factor = heightFactor(state.units, opts.demFeet);
    if (source === 'file') {
      if (!dem) return;
      try {
        const plan = planElevations(doc, targets, demSampler(dem.raster, crs?.crs ?? null), factor);
        report(applyElevations(state.store, plan, dem.name), plan.outside, dem.name);
      } catch (e) {
        setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
    if (!crs) return;
    setBusy(true);
    setMessage({ ok: true, text: 'Fetching terrain tiles…' });
    try {
      const where = targets.map((h): [number, number] => crs.crs.toLngLat(doc.num(h, 'x'), doc.num(h, 'y')));
      const { heights, tiles } = await sampleTerrain(where, (z, x, y) => fetchTerrainTile(z, x, y));
      const byHandle = new Map(targets.map((h, i) => [h, heights[i]!]));
      const plan = planElevations(doc, targets, (_x, _y, h) => byHandle.get(h) ?? NaN, factor);
      report(
        applyElevations(state.store, plan, `online terrain (${tiles} tiles)`),
        plan.outside,
        `online terrain (${tiles} tiles)`,
      );
    } catch (e) {
      setMessage({
        ok: false,
        text: `Terrain tiles could not be read: ${e instanceof Error ? e.message : String(e)}`,
      });
    } finally {
      setBusy(false);
    }
  };

  const bounds = dem ? rasterBounds(dem.raster) : null;
  return (
    <div className="tools-body">
      <p className="muted">
        Sets the elevation of junctions and tanks from the ground height under each one, in {unit}. Reservoirs
        keep their head.
      </p>
      <fieldset className="tools-fields">
        <legend>Heights from</legend>
        <label className="check">
          <input
            type="radio"
            name={`${id}-src`}
            checked={source === 'file'}
            onChange={() => setSource('file')}
          />
          A DEM file (GeoTIFF or ESRI ASCII grid)
        </label>
        <label className="check">
          <input
            type="radio"
            name={`${id}-src`}
            checked={source === 'terrain'}
            onChange={() => setSource('terrain')}
          />
          Online terrain tiles
        </label>
      </fieldset>
      {source === 'file' ? (
        <div className="tools-row">
          <button type="button" className="btn" onClick={() => void chooseDem()}>
            Choose DEM…
          </button>
          {dem && bounds && (
            <span className="muted" role="status">
              {dem.name}: {dem.raster.width} × {dem.raster.height} cells of{' '}
              {Math.abs(dem.raster.dx).toPrecision(4)}
              {dem.raster.epsg
                ? `, EPSG:${dem.raster.epsg}`
                : ', no coordinate system (the network’s is assumed)'}
            </span>
          )}
        </div>
      ) : crs ? (
        <p className="muted">
          {TERRAIN_ATTRIBUTION}. Heights are about 10 m apart at best; check them where it matters.
        </p>
      ) : (
        <p className="field-error" role="alert">
          The network has no coordinate system, so it cannot be placed on the terrain. Set one with View ›
          Coordinates.
        </p>
      )}
      <div className="tools-fields">
        <Scope value={scope} onChange={setScope} what="junction or tank" />
        <label className="check">
          <input type="checkbox" checked={onlyZero} onChange={(e) => setOnlyZero(e.target.checked)} />
          Only nodes whose elevation is 0
        </label>
        {source === 'file' && (
          <label className="check">
            <input type="checkbox" checked={demFeet} onChange={(e) => setDemFeet(e.target.checked)} />
            The DEM’s heights are in feet
          </label>
        )}
      </div>
      <div className="tools-row">
        <button
          type="button"
          className="btn primary"
          disabled={busy || (source === 'file' ? !dem : !crs)}
          onClick={() => void run()}
        >
          Set elevations
        </button>
      </div>
      <Status message={message} />
    </div>
  );
}

/** Demand points from GeoJSON: Point features with a numeric property. */
function pointsFromGeoJSON(
  text: string,
  field: string,
  project: ((lng: number, lat: number) => [number, number]) | null,
): { points: DemandPoint[]; issues: string[] } {
  const fc = JSON.parse(text) as {
    features?: {
      geometry?: { type?: string; coordinates?: number[] };
      properties?: Record<string, unknown>;
    }[];
  };
  const points: DemandPoint[] = [];
  let skipped = 0;
  for (const f of fc.features ?? []) {
    const c = f.geometry?.type === 'Point' ? f.geometry.coordinates : undefined;
    const q = Number(f.properties?.[field]);
    if (!c || c.length < 2 || !Number.isFinite(q)) {
      skipped++;
      continue;
    }
    const [x, y] = project ? project(c[0]!, c[1]!) : [c[0]!, c[1]!];
    points.push({ x, y, demand: q });
  }
  return { points, issues: skipped ? [`${skipped} features are not points with a numeric “${field}”.`] : [] };
}

function Demands({ state }: { state: AppState }) {
  const [method, setMethod] = useState<'total' | 'points'>('total');
  const [total, setTotal] = useState('');
  const [totalMethod, setTotalMethod] = useState<TotalMethod>('length');
  const [scope, setScope] = useState<'all' | 'selected'>('all');
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [columns, setColumns] = useState({ x: 'x', y: 'y', demand: 'demand' });
  const [pointMethod, setPointMethod] = useState<PointMethod>('pipe');
  const [maxDistance, setMaxDistance] = useState('');
  const [category, setCategory] = useState('');
  const [pattern, setPattern] = useState('');
  const [add, setAdd] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const doc = state.store.doc;
  const flow = unitLabel('flow', state.units);
  const patterns = doc.data.patterns.map((p) => p.id);

  const readPoints = (): { points: DemandPoint[]; issues: string[] } | null => {
    if (!file) return null;
    if (/\.(geo)?json$/i.test(file.name)) {
      const crs = modelCrs(doc);
      return pointsFromGeoJSON(
        file.text,
        columns.demand,
        crs ? (lng, lat) => crs.crs.fromLngLat(lng, lat) : null,
      );
    }
    return parseDemandPoints(file.text, columns);
  };

  const run = () => {
    const targets = junctions(doc, scope === 'selected' ? state.selection : undefined);
    if (targets.length === 0) {
      setMessage({ ok: false, text: 'No junctions to allocate to: check what the tool applies to.' });
      return;
    }
    const target = { category: category.trim(), pattern: pattern || null, add };
    if (method === 'total') {
      const q = Number(total);
      if (!total.trim() || !Number.isFinite(q)) {
        setMessage({ ok: false, text: `Enter the total demand to spread, in ${flow}.` });
        return;
      }
      const alloc = allocateTotal(doc, targets, q, totalMethod);
      const n = applyAllocation(
        state.store,
        alloc,
        target,
        `Allocate ${q} ${flow} over ${targets.length} junctions`,
      );
      setMessage({
        ok: true,
        text: `Allocated ${q} ${flow} over ${n} junctions${totalMethod === 'length' ? ' by the length of pipe each serves' : ' equally'}.`,
      });
      return;
    }
    let read;
    try {
      read = readPoints();
    } catch (e) {
      setMessage({
        ok: false,
        text: `${file?.name ?? 'The file'} is not valid: ${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (!read) return;
    if (read.points.length === 0) {
      setMessage({ ok: false, text: read.issues[0] ?? 'The file has no demand points.' });
      return;
    }
    const limit = maxDistance.trim() ? Number(maxDistance) : Infinity;
    const alloc = allocatePoints(
      doc,
      targets,
      read.points,
      pointMethod,
      Number.isFinite(limit) && limit > 0 ? limit : Infinity,
    );
    const sum = read.points.reduce((a, p) => a + p.demand, 0);
    const n = applyAllocation(state.store, alloc, target, `Allocate ${read.points.length} demand points`);
    const extra = [
      alloc.unassigned ? `${alloc.unassigned} points found no junction within reach.` : '',
      ...read.issues.slice(0, 2),
    ].filter(Boolean);
    setMessage({
      ok: true,
      text: `Allocated ${read.points.length - alloc.unassigned} of ${read.points.length} points (${Math.round(sum * 1000) / 1000} ${flow}) to ${n} junctions. ${extra.join(' ')}`.trim(),
    });
  };

  return (
    <div className="tools-body">
      <fieldset className="tools-fields">
        <legend>Demand from</legend>
        <label className="check">
          <input
            type="radio"
            name="alloc-method"
            checked={method === 'total'}
            onChange={() => setMethod('total')}
          />
          A total spread over junctions
        </label>
        <label className="check">
          <input
            type="radio"
            name="alloc-method"
            checked={method === 'points'}
            onChange={() => setMethod('points')}
          />
          Customer demands at points (CSV or GeoJSON)
        </label>
      </fieldset>
      {method === 'total' ? (
        <div className="tools-fields">
          <label>
            <span>Total demand ({flow})</span>
            <input inputMode="decimal" value={total} onChange={(e) => setTotal(e.target.value)} />
          </label>
          <label>
            <span>Spread</span>
            <select value={totalMethod} onChange={(e) => setTotalMethod(e.target.value as TotalMethod)}>
              <option value="length">By the length of pipe each junction serves</option>
              <option value="equal">Equally</option>
            </select>
          </label>
        </div>
      ) : (
        <div className="tools-fields">
          <div className="tools-row">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void openFilePicker('.csv,.tsv,.txt,.geojson,.json').then(async (f) => {
                  if (f) setFile({ name: f.name, text: await f.text() });
                })
              }
            >
              Choose points…
            </button>
            {file && <span className="muted">{file.name}</span>}
          </div>
          <p className="muted">
            CSV or tab-separated text with a header row, coordinates in the network’s system; or GeoJSON
            points in longitude and latitude, projected with the network’s coordinate system when it has one.
          </p>
          {(['x', 'y', 'demand'] as const).map((k) =>
            k !== 'demand' && file && /json$/i.test(file.name) ? null : (
              <label key={k}>
                <span>
                  {k === 'demand' ? `Demand column or property (${flow})` : `${k.toUpperCase()} column`}
                </span>
                <input value={columns[k]} onChange={(e) => setColumns({ ...columns, [k]: e.target.value })} />
              </label>
            ),
          )}
          <label>
            <span>Assign each point to</span>
            <select value={pointMethod} onChange={(e) => setPointMethod(e.target.value as PointMethod)}>
              <option value="pipe">The nearest pipe, split between its ends</option>
              <option value="node">The nearest junction</option>
            </select>
          </label>
          <label>
            <span>Farthest distance (blank for any)</span>
            <input inputMode="decimal" value={maxDistance} onChange={(e) => setMaxDistance(e.target.value)} />
          </label>
        </div>
      )}
      <div className="tools-fields">
        <Scope value={scope} onChange={setScope} what="junction" />
        <label>
          <span>Demand category (blank for the first)</span>
          <input value={category} onChange={(e) => setCategory(e.target.value)} />
        </label>
        <label>
          <span>Time pattern</span>
          <select value={pattern} onChange={(e) => setPattern(e.target.value)}>
            <option value="">Keep the category’s</option>
            {patterns.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={add} onChange={(e) => setAdd(e.target.checked)} />
          Add to the demand already there (otherwise replace it)
        </label>
      </div>
      <div className="tools-row">
        <button type="button" className="btn primary" disabled={method === 'points' && !file} onClick={run}>
          Allocate demands
        </button>
      </div>
      <Status message={message} />
    </div>
  );
}

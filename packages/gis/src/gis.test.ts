import type { model } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { emptyModel } from './build.ts';
import { dxfToModel, modelToDxf } from './dxf.ts';
import { geoJSONToModel, modelToGeoJSON, type FeatureCollection, type Projector } from './geojson.ts';
import {
  crsFromPrj,
  layersFromFiles,
  modelToShapefiles,
  readDbf,
  readShp,
  shapefilesToModel,
  writeDbf,
} from './shapefile.ts';
import { readZip, writeZip } from './zip.ts';

const node = (id: string, x: number, y: number, kind: model.NodeKind): model.Node => ({
  id,
  kind,
  comment: null,
  tag: null,
  coordinates: [x, y],
  initialQuality: null,
  source: null,
});
const junction = (elevation: number, base = 1): model.NodeKind => ({
  type: 'junction',
  elevation,
  demands: [{ base, pattern: null, category: null }],
  emitter: null,
});
const pipe = (
  id: string,
  from: string,
  to: string,
  length: number,
  vertices: [number, number][] = [],
): model.Link => ({
  id,
  from,
  to,
  kind: {
    type: 'pipe',
    length,
    diameter: 200,
    roughness: 120,
    minorLoss: 0,
    status: 'open',
    leakage: null,
    bulkCoeff: null,
    wallCoeff: null,
  },
  comment: null,
  tag: null,
  vertices,
});

function sample(): model.Model {
  const m = emptyModel('LPS');
  m.nodes = [
    node('R1', 0, 0, { type: 'reservoir', head: 50, pattern: null, level: 0 }),
    node('A', 100, 0, junction(10, 2)),
    node('B', 100, 100, junction(12, 3)),
  ];
  m.links = [pipe('1', 'R1', 'A', 100), pipe('2', 'A', 'B', 120, [[120, 50]])];
  return m;
}

// A toy projection: metres east and north of (10°E, 50°N) on a sphere.
const R = 6371000;
const toy: Projector = {
  toLngLat: (x, y) => [
    10 + (x / (R * Math.cos((50 * Math.PI) / 180))) * (180 / Math.PI),
    50 + (y / R) * (180 / Math.PI),
  ],
  fromLngLat: (lng, lat) => [
    ((lng - 10) * Math.PI * R * Math.cos((50 * Math.PI) / 180)) / 180,
    ((lat - 50) * Math.PI * R) / 180,
  ],
};

describe('GeoJSON', () => {
  it('exports nodes as points and links as lines with their attributes', () => {
    const fc = modelToGeoJSON(sample(), {
      extra: (t, id) => (t === 'node' && id === 'A' ? { pressure: 40 } : undefined),
    });
    expect(fc.features).toHaveLength(5);
    const a = fc.features.find((f) => f.id === 'node:A')!;
    expect(a.properties).toMatchObject({ id: 'A', type: 'junction', elevation: 10, demand: 2, pressure: 40 });
    const p2 = fc.features.find((f) => f.id === 'link:2')!;
    expect(p2.geometry).toEqual({
      type: 'LineString',
      coordinates: [
        [100, 0],
        [120, 50],
        [100, 100],
      ],
    });
    expect(fc['waterstudio']).toBeDefined(); // no CRS: says so
  });

  it('writes longitude and latitude when the model has a coordinate system', () => {
    const fc = modelToGeoJSON(sample(), { project: toy });
    const r = fc.features.find((f) => f.id === 'node:R1')!;
    expect(r.geometry).toEqual({ type: 'Point', coordinates: [10, 50] });
    expect(fc['waterstudio']).toBeUndefined();
  });

  it('round-trips a network', () => {
    const fc = modelToGeoJSON(sample(), { project: toy });
    const { model: m, issues } = geoJSONToModel(fc, { project: toy, snap: 0.5, units: 'LPS' });
    expect(issues).toEqual([]);
    expect(m.nodes.map((n) => [n.id, n.kind.type])).toEqual([
      ['R1', 'reservoir'],
      ['A', 'junction'],
      ['B', 'junction'],
    ]);
    expect(m.links.map((l) => [l.id, l.from, l.to])).toEqual([
      ['1', 'R1', 'A'],
      ['2', 'A', 'B'],
    ]);
    const b = m.nodes[2]!;
    // Longitude and latitude are written to 8 decimals: about a millimetre.
    expect(b.coordinates![0]).toBeCloseTo(100, 2);
    expect(b.coordinates![1]).toBeCloseTo(100, 2);
    expect(m.links[1]!.vertices).toHaveLength(1);
    expect(m.links[1]!.kind).toMatchObject({ type: 'pipe', length: 120, diameter: 200, roughness: 120 });
  });

  it('builds a network from bare lines, snapping their ends', () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [0, 0] },
          properties: { type: 'Reservoir', head: 30 },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'LineString',
            coordinates: [
              [0.2, 0.1],
              [30, 40],
            ],
          },
          properties: { DIAMETER: 300 },
        },
        {
          type: 'Feature',
          geometry: {
            type: 'MultiLineString',
            coordinates: [
              [
                [30, 40],
                [60, 40],
              ],
              [
                [60, 40],
                [60, 0],
              ],
            ],
          },
          properties: { id: 'M' },
        },
        { type: 'Feature', geometry: null, properties: {} },
      ],
    };
    const { model: m, issues } = geoJSONToModel(fc, { snap: 1, units: 'LPS' });
    expect(m.nodes.map((n) => n.id)).toEqual(['J1', 'J2', 'J3', 'J4']);
    expect(m.nodes[0]!.kind).toMatchObject({ type: 'reservoir', head: 30 });
    expect(m.links.map((l) => [l.id, l.from, l.to])).toEqual([
      ['P1', 'J1', 'J2'],
      ['M', 'J2', 'J3'],
      ['M_2', 'J3', 'J4'],
    ]);
    expect(m.links[0]!.kind).toMatchObject({ diameter: 300, length: expect.closeTo(50, 0) as number });
    expect(issues.join(' ')).toContain('3 junctions were created');
    expect(issues.join(' ')).toContain('1 features without');
  });
});

describe('DXF', () => {
  it('exports layers, polylines, points and labels', () => {
    const dxf = modelToDxf(sample(), { labels: true });
    expect(dxf).toContain('AC1009');
    expect(dxf.match(/\nPOLYLINE\n/g)).toHaveLength(2);
    expect(dxf.match(/\nPOINT\n/g)).toHaveLength(3);
    expect(dxf).toContain('\nRESERVOIRS\n');
    expect(dxf.trimEnd().endsWith('EOF')).toBe(true);
  });

  it('round-trips connectivity and node types', () => {
    const { model: m, issues } = dxfToModel(modelToDxf(sample(), { labels: true }), {
      snap: 0.01,
      units: 'LPS',
    });
    expect(issues[0]).toContain('not lines or points'); // the labels
    expect(m.nodes.map((n) => n.kind.type)).toEqual(['reservoir', 'junction', 'junction']);
    expect(m.nodes[1]!.kind).toMatchObject({ elevation: 10 });
    expect(m.links).toHaveLength(2);
    expect(m.links[1]!.vertices).toEqual([[120, 50]]);
    const ends = m.links.map((l) => [l.from, l.to]);
    expect(ends[0]![1]).toBe(ends[1]![0]); // the two pipes share a node
  });

  it('reads LINE and LWPOLYLINE entities', () => {
    const dxf = [
      '0',
      'SECTION',
      '2',
      'ENTITIES',
      '0',
      'LINE',
      '8',
      'MAINS',
      '10',
      '0',
      '20',
      '0',
      '11',
      '10',
      '21',
      '0',
      '0',
      'LWPOLYLINE',
      '8',
      'MAINS',
      '90',
      '3',
      '10',
      '10',
      '20',
      '0',
      '10',
      '10',
      '20',
      '10',
      '10',
      '20',
      '20',
      '10',
      '0',
      'CIRCLE',
      '8',
      'TANK',
      '10',
      '20',
      '20',
      '10',
      '40',
      '1',
      '0',
      'ENDSEC',
      '0',
      'EOF',
    ].join('\n');
    const { model: m } = dxfToModel(dxf, { snap: 0.1, units: 'GPM' });
    // The polyline ends on the tank and starts where the line ends.
    expect(m.nodes.map((n) => n.kind.type)).toEqual(['tank', 'junction', 'junction']);
    expect(m.links.map((l) => l.kind.type === 'pipe' && Math.round(l.kind.length))).toEqual([10, 20]);
  });
});

describe('shapefiles', () => {
  it('round-trips a network through node and link layers', () => {
    const m = sample();
    m.nodes[1]!.initialQuality = 0.5;
    m.nodes[1]!.comment = 'Café corner';
    const files = modelToShapefiles(m, 'net', {
      extra: (t, id) => (t === 'node' && id === 'B' ? { pressure: 31.25 } : undefined),
    });
    expect(files.map(([n]) => n)).toEqual([
      'net_nodes.shp',
      'net_nodes.shx',
      'net_nodes.dbf',
      'net_nodes.cpg',
      'net_links.shp',
      'net_links.shx',
      'net_links.dbf',
      'net_links.cpg',
    ]);
    const shp = readShp(files[4]![1]);
    expect(shp.geometries[1]).toEqual({
      type: 'line',
      parts: [
        [
          [100, 0],
          [120, 50],
          [100, 100],
        ],
      ],
    });
    const rows = readDbf(files[2]![1], 'UTF-8');
    expect(rows[1]).toMatchObject({
      id: 'A',
      type: 'junction',
      elevation: 10,
      demand: 2,
      init_qual: 0.5,
      descr: 'Café corner',
    });
    expect(rows[2]).toMatchObject({ pressure: 31.25 });
    const back = shapefilesToModel(layersFromFiles(new Map(files)), { snap: 0.5, units: 'LPS' });
    expect(back.model.nodes.map((n) => n.id)).toEqual(['R1', 'A', 'B']);
    expect(back.model.links.map((l) => [l.id, l.from, l.to])).toEqual([
      ['1', 'R1', 'A'],
      ['2', 'A', 'B'],
    ]);
    const a = back.model.nodes.find((n) => n.id === 'A')!;
    expect(a.initialQuality).toBe(0.5);
    expect(a.comment).toBe('Café corner');
    expect(back.model.links[1]!.vertices).toEqual([[120, 50]]);
  });

  it('writes longitude and latitude with a WGS 84 .prj when projected', () => {
    const files = new Map(modelToShapefiles(sample(), 'n', { project: toy }));
    const prj = new TextDecoder().decode(files.get('n_nodes.prj'));
    expect(crsFromPrj(prj)).toBe('geographic');
    const g = readShp(files.get('n_nodes.shp')!).geometries[0];
    expect(g).toMatchObject({ type: 'point', x: 10, y: 50 });
  });

  it('recognises coordinate systems in .prj files', () => {
    expect(crsFromPrj('PROJCS["WGS 84 / UTM zone 33N",GEOGCS["WGS 84"],AUTHORITY["EPSG","32633"]]')).toBe(
      'EPSG:32633',
    );
    expect(crsFromPrj('PROJCS["WGS_1984_UTM_Zone_36S",GEOGCS["GCS_WGS_1984"]]')).toBe('EPSG:32736');
    expect(crsFromPrj('PROJCS["Somewhere_Local",GEOGCS["x"]]')).toBeNull();
  });

  it('keeps text and numbers apart in dBASE tables', () => {
    const rows = readDbf(
      writeDbf([
        { id: 'X', n: 3, f: 1.5 },
        { id: 'LONGER', n: null, f: -2 },
      ]),
    );
    expect(rows).toEqual([
      { id: 'X', n: 3, f: 1.5 },
      { id: 'LONGER', n: null, f: -2 },
    ]);
  });
});

describe('zip', () => {
  it('reads what it writes, and deflated entries', async () => {
    const a = new TextEncoder().encode('hello hello hello hello');
    const files = await readZip(
      writeZip([
        ['dir/a.txt', a],
        ['b.bin', new Uint8Array([1, 2, 3])],
      ]),
    );
    expect(new TextDecoder().decode(files.get('dir/a.txt'))).toBe('hello hello hello hello');
    expect([...files.get('b.bin')!]).toEqual([1, 2, 3]);
    // A deflated entry: compress, store it, then mark both headers as method 8.
    const stream = new Blob([a]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    const zip = writeZip([['c.txt', packed]]);
    const v = new DataView(zip.buffer);
    v.setUint16(8, 8, true);
    const central = v.getUint32(zip.length - 6, true);
    v.setUint16(central + 10, 8, true);
    expect(new TextDecoder().decode((await readZip(zip)).get('c.txt'))).toBe('hello hello hello hello');
  });
});

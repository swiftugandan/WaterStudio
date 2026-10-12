import { readAsciiGrid } from '@waterstudio/gis';
import { loadModel, Store, type model } from '@waterstudio/core';
import { describe, expect, it } from 'vitest';
import { resolveCrs } from '../geo/crs.ts';
import { applyElevations, demSampler, elevationTargets, heightFactor, planElevations } from './elevations.ts';
import { emptyModel } from './state.ts';

function net(): Store {
  const node = (
    id: string,
    type: 'junction' | 'tank' | 'reservoir',
    x: number,
    elevation: number,
  ): model.Node =>
    ({
      id,
      kind:
        type === 'junction'
          ? { type, elevation, demands: [], emitter: null }
          : type === 'reservoir'
            ? { type, head: 100, pattern: null }
            : {
                type,
                elevation,
                initLevel: 1,
                minLevel: 0,
                maxLevel: 2,
                diameter: 10,
                minVolume: 0,
                volumeCurve: null,
                overflow: false,
                mixing: null,
              },
      coordinates: [x, 2010],
      tag: null,
      initialQuality: null,
      source: null,
      comment: null,
    }) as model.Node;
  const store = new Store();
  loadModel(store, {
    ...emptyModel(),
    nodes: [
      node('J1', 'junction', 1005, 0),
      node('J2', 'junction', 1010, 7),
      node('T', 'tank', 1025, 0),
      node('R', 'reservoir', 1005, 0),
      node('X', 'junction', 5000, 0),
    ],
  });
  return store;
}

const DEM = readAsciiGrid(
  'ncols 3\nnrows 2\nxllcorner 1000\nyllcorner 2000\ncellsize 10\n10 20 30\n40 50 60\n',
);

describe('elevations from a DEM', () => {
  it('sets junction and tank elevations, skipping reservoirs and nodes off the DEM', () => {
    const s = net();
    const targets = elevationTargets(s.doc, new Set(), { scope: 'all', onlyZero: false, demFeet: false });
    expect(targets.map((h) => s.doc.id(h))).toEqual(['J1', 'J2', 'T', 'X']);
    const plan = planElevations(s.doc, targets, demSampler(DEM, null), 1);
    expect(plan.outside).toEqual(['X']);
    expect(plan.updates.map(([h, z]) => [s.doc.id(h), z])).toEqual([
      ['J1', 25],
      ['J2', 30],
      ['T', 45],
    ]);
    expect(applyElevations(s, plan, 'test.asc')).toBe(3);
    expect(s.doc.num(s.doc.findNode('T')!, 'elevation')).toBe(45);
  });

  it('can keep elevations already set, and converts metres to feet', () => {
    const s = net();
    const targets = elevationTargets(s.doc, new Set(), { scope: 'all', onlyZero: true, demFeet: false });
    expect(targets.map((h) => s.doc.id(h))).toEqual(['J1', 'T', 'X']);
    expect(heightFactor({ si: false } as never, false)).toBeCloseTo(3.28084);
    expect(heightFactor({ si: true } as never, true)).toBe(0.3048);
  });

  it('reprojects when the DEM names another coordinate system', () => {
    const model = resolveCrs('EPSG:32633')!;
    const [lng, lat] = model.toLngLat(500000, 5500000);
    const geo = { ...DEM, x0: lng - 0.001, y0: lat + 0.001, dx: 0.001, dy: -0.001, epsg: 4326 };
    const z = demSampler(geo, model)(500000, 5500000);
    expect(z).toBeGreaterThan(10);
    expect(z).toBeLessThan(60);
    expect(() => demSampler({ ...DEM, epsg: 2056 }, model)).toThrow(/EPSG:2056/);
  });
});
